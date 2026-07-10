'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const lockfile = require('proper-lockfile');
const {
  appendJsonlDurable,
  fsyncDirectory,
  writeFileDurable,
} = require('../../utils/durable-write.js');
const {
  INLINE_RESULT_LIMIT_BYTES,
  OPERATION_EVENT_MAX_BYTES,
  OPERATION_EVENT_MAX_COUNT,
  OPERATION_ID_PATTERN,
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
  RESULT_HANDLE_PATTERN,
  SHA256_HEX_PATTERN,
  SHA256_PATTERN,
  TERMINAL_STATES,
  assertExpectedVersion,
  assertIdentifier,
  assertOperationId,
  assertResultHandle,
  assertTransition,
  buildBrainOperationIdempotencyKey,
  buildRequestFingerprint,
  operationError,
  projectPublicRecord,
  safeJsonClone,
  validateCreateInput,
  validateResultObject,
  validateSourceEvidence,
  validateSourcePin,
  validateTargetSnapshot,
  validateTransitionError,
} = require('./operation-contract.js');
const {
  canonicalJson,
  canonicalSha256,
} = require('../../../../shared/brain-operations/canonical-json.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 7 * DAY_MS;
const METADATA_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_LOCK_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const MAX_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const EVENT_FILE = 'events.jsonl';
const RESULT_JSON_FILE = 'result.json';
const RESULT_ARTIFACT_FILE = 'result.artifact';
const SCRATCH_DIRECTORY = 'scratch';
const IMPORTANT_EVENT_TYPES = new Set([
  'phase',
  'provider_selected',
  'provider_activity',
  'provider_call_terminal',
  'source_pin_attached',
  'state',
  'event_gap',
]);
const NOISY_EVENT_TYPES = new Set([
  'heartbeat',
  'progress',
  'progress_update',
  'token',
  'token_estimate',
]);
const PRIVATE_RECORD_FIELDS = Object.freeze([
  'operationId',
  'requestId',
  'operationType',
  'requestParameters',
  'parameters',
  'canonicalEvidence',
  'recordVersion',
  'eventSequence',
  'requesterAgent',
  'target',
  'state',
  'phase',
  'startedAt',
  'updatedAt',
  'completedAt',
  'lastProviderActivityAt',
  'lastProgressAt',
  'result',
  'resultHandle',
  'resultArtifact',
  'error',
  'sourceEvidence',
  'sourcePinDescriptor',
  'sourcePinDigest',
  'sourcePinReleasedAt',
  'resultExpiresAt',
  'resultExpiredAt',
  'metadataExpiresAt',
  '_idempotencyKey',
  '_requestFingerprint',
  '_worker',
  '_resultKind',
  '_resultCleanup',
  '_eventBytes',
  '_eventOldestSequence',
  '_deleting',
]);
const EVENT_PRIVATE_PATH_FIELDS = new Set([
  'scratchPath',
  'privatePath',
  'sourcePath',
  'artifactPath',
]);

function exactInputKeys(value, allowed, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw operationError(code);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) throw operationError(code);
  }
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function timingSafeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
      || !SHA256_HEX_PATTERN.test(left) || !SHA256_HEX_PATTERN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sameFileIdentity(left, right) {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameArtifactSourceIdentity(left, right) {
  return sameFileIdentity(left, right)
    && left.nlink === right.nlink;
}

function assertConfiguredRootCanonical(root) {
  let cursor = root;
  const missing = [];
  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw operationError('store_configuration_invalid');
      const real = fs.realpathSync.native(cursor);
      if (real !== cursor) throw operationError('store_configuration_invalid');
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.code === 'store_configuration_invalid') throw error;
        throw operationError('store_configuration_invalid', error);
      }
      missing.unshift(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) throw operationError('store_configuration_invalid', error);
      cursor = parent;
    }
  }
  let rebuilt = cursor;
  for (const component of missing) {
    if (component === '.' || component === '..' || component === '') {
      throw operationError('store_configuration_invalid');
    }
    rebuilt = path.join(rebuilt, component);
  }
  if (rebuilt !== root) throw operationError('store_configuration_invalid');
}

function assertIsoOrNull(value, code = 'operation_corrupt') {
  if (value === null) return;
  if (typeof value !== 'string') throw operationError(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw operationError(code);
  }
}

function assertPlainObjectOrNull(value, code = 'operation_corrupt') {
  if (value === null) return;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw operationError(code);
  safeJsonClone(value, code);
}

function assertPlainObject(value, code = 'operation_corrupt') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw operationError(code);
  safeJsonClone(value, code);
}

function assertResultArtifactMetadata(value, expectedKind, code = 'operation_corrupt') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw operationError(code);
  exactInputKeys(value, ['mediaType', 'contentEncoding', 'bytes', 'sha256'], code);
  if (value.contentEncoding !== 'identity'
      || !Number.isSafeInteger(value.bytes)
      || value.bytes < 0
      || typeof value.sha256 !== 'string'
      || !SHA256_HEX_PATTERN.test(value.sha256)) {
    throw operationError(code);
  }
  if (expectedKind === 'json-file' && value.mediaType !== 'application/json') {
    throw operationError(code);
  }
  if (expectedKind === 'artifact' && value.mediaType !== 'application/x-ndjson') {
    throw operationError(code);
  }
  if (expectedKind === 'expired'
      && value.mediaType !== 'application/json'
      && value.mediaType !== 'application/x-ndjson') {
    throw operationError(code);
  }
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function eventLine(event) {
  return `${canonicalJson(event)}\n`;
}

function eventBytes(events) {
  return events.reduce((total, event) => total + Buffer.byteLength(eventLine(event), 'utf8'), 0);
}

function oldestContiguousSequence(events, latestSequence) {
  if (events.length === 0) return latestSequence + 1;
  let expected = latestSequence;
  let oldest = latestSequence + 1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const sequence = events[index].sequence;
    if (sequence !== expected) break;
    oldest = sequence;
    expected -= 1;
  }
  return oldest;
}

function isImportantEvent(event) {
  return IMPORTANT_EVENT_TYPES.has(event.type) || TERMINAL_STATES.has(event.state);
}

function isNoisyEvent(event) {
  return NOISY_EVENT_TYPES.has(event.type);
}

class BrainOperationStore {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw operationError('store_configuration_invalid');
    }
    const root = options.root ?? options.operationsRoot;
    if (typeof root !== 'string'
        || !path.isAbsolute(root)
        || path.normalize(root) !== root
        || root.includes('\0')) {
      throw operationError('store_configuration_invalid');
    }
    assertConfiguredRootCanonical(root);
    assertIdentifier(options.requesterAgent, 'requesterAgent');
    this.root = root;
    this.requesterAgent = options.requesterAgent;
    this.operationsRoot = path.join(root, 'operations');
    this.idempotencyRoot = path.join(root, 'idempotency');
    this.idempotencyIndexPath = path.join(this.idempotencyRoot, 'index.json');
    this.idempotencyLockPath = path.join(this.idempotencyRoot, '.index.lock');
    this.resultHandlesRoot = path.join(root, 'result-handles');
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.crashInjector = typeof options.crashInjector === 'function'
      ? options.crashInjector
      : async () => {};
    this.eventMaxCount = Number.isSafeInteger(options.eventMaxCount) && options.eventMaxCount > 0
      ? Math.min(options.eventMaxCount, OPERATION_EVENT_MAX_COUNT)
      : OPERATION_EVENT_MAX_COUNT;
    this.eventMaxBytes = Number.isSafeInteger(options.eventMaxBytes) && options.eventMaxBytes > 0
      ? Math.min(options.eventMaxBytes, OPERATION_EVENT_MAX_BYTES)
      : OPERATION_EVENT_MAX_BYTES;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.lockTimeoutMs)
        || this.lockTimeoutMs <= 0
        || this.lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
      throw operationError('store_configuration_invalid');
    }
    this.lockOptions = {
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: {
        retries: 8,
        forever: true,
        minTimeout: Math.min(10, this.lockTimeoutMs),
        maxTimeout: Math.min(1000, this.lockTimeoutMs),
        factor: 2,
        maxRetryTime: this.lockTimeoutMs,
      },
    };
    this.operationQueues = new Map();
    this.idempotencyQueue = new Map();
    this.handleIndexQueue = new Map();
    this.eventCache = new Map();
  }

  _nowMs(explicit) {
    let value = explicit;
    if (value === undefined) value = this.now();
    if (value instanceof Date) value = value.getTime();
    if (typeof value === 'string') value = Date.parse(value);
    if (!Number.isFinite(value)) throw operationError('clock_invalid');
    return Number(value);
  }

  _operationDirectory(operationId) {
    assertOperationId(operationId);
    return path.join(this.operationsRoot, operationId);
  }

  _statusPath(operationId) {
    return path.join(this._operationDirectory(operationId), 'status.json');
  }

  _eventPath(operationId) {
    return path.join(this._operationDirectory(operationId), EVENT_FILE);
  }

  _attachmentPath(operationId, attachmentId) {
    assertIdentifier(attachmentId, 'attachmentId');
    return path.join(this._operationDirectory(operationId), 'attachments', `${attachmentId}.json`);
  }

  _resultJsonPath(operationId) {
    return path.join(this._operationDirectory(operationId), RESULT_JSON_FILE);
  }

  _resultArtifactPath(operationId) {
    return path.join(this._operationDirectory(operationId), RESULT_ARTIFACT_FILE);
  }

  _scratchPath(operationId) {
    return path.join(this._operationDirectory(operationId), SCRATCH_DIRECTORY);
  }

  _resultHandleHash(handle) {
    assertResultHandle(handle);
    return crypto.createHash('sha256').update(handle, 'utf8').digest('hex');
  }

  _resultHandleIndexPath(hash) {
    if (!SHA256_HEX_PATTERN.test(hash)) throw operationError('result_handle_invalid');
    return path.join(this.resultHandlesRoot, `${hash}.json`);
  }

  async _eventFileIdentity(operationId) {
    try {
      const stat = await fsp.lstat(this._eventPath(operationId), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw operationError('operation_corrupt');
      return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async _inject(stage, details = {}) {
    return this.crashInjector(stage, details);
  }

  async _writeJson(filePath, value, stage, afterRenameStage = null) {
    const content = `${canonicalJson(value)}\n`;
    return writeFileDurable(filePath, content, {
      encoding: 'utf8',
      mode: 0o600,
      strictDirectorySync: true,
      beforeRename: stage ? () => this._inject(stage, { filePath }) : undefined,
      afterRename: afterRenameStage
        ? () => this._inject(afterRenameStage, { filePath })
        : undefined,
    });
  }

  async _syncDirectory(directoryPath) {
    if (typeof fsyncDirectory === 'function') await fsyncDirectory(directoryPath, { strict: true });
  }

  async _ensureDirectory(directoryPath, code = 'store_path_invalid') {
    try {
      const existing = await fsp.lstat(directoryPath);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw operationError(code);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fsp.mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const created = await fsp.lstat(directoryPath);
    if (!created.isDirectory() || created.isSymbolicLink()) throw operationError(code);
    await this._syncDirectory(path.dirname(directoryPath));
    return true;
  }

  async _captureDirectoryIdentities(directoryPaths, code) {
    const identities = new Map();
    for (const directoryPath of [...new Set(directoryPaths)]) {
      let stat;
      try {
        stat = await fsp.lstat(directoryPath, { bigint: true });
      } catch (error) {
        throw operationError(code, error);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw operationError(code);
      identities.set(directoryPath, { dev: stat.dev, ino: stat.ino });
    }
    return identities;
  }

  async _verifyDirectoryIdentities(identities, code) {
    for (const [directoryPath, expected] of identities) {
      let stat;
      try {
        stat = await fsp.lstat(directoryPath, { bigint: true });
      } catch (error) {
        throw operationError(code, error);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()
          || stat.dev !== expected.dev || stat.ino !== expected.ino) {
        throw operationError(code);
      }
    }
  }

  async _withDirectoryConfinement(directoryPaths, code, callback) {
    const identities = await this._captureDirectoryIdentities(directoryPaths, code);
    await this._verifyDirectoryIdentities(identities, code);
    let result;
    let callbackError;
    try {
      result = await callback();
    } catch (error) {
      callbackError = error;
    }
    await this._verifyDirectoryIdentities(identities, code);
    if (callbackError) throw callbackError;
    return result;
  }

  _operationAncestorPaths(operationId) {
    return [this.root, this.operationsRoot, this._operationDirectory(operationId)];
  }

  async _withLock(targetPath, lockPath, callback) {
    let release;
    try {
      try {
        release = await lockfile.lock(targetPath, {
          ...this.lockOptions,
          lockfilePath: lockPath,
        });
      } catch (error) {
        if (error?.code === 'ELOCKED') throw operationError('operation_lock_timeout', error);
        throw error;
      }
      return await callback();
    } finally {
      if (release) await release();
    }
  }

  async _serialize(queue, key, callback) {
    const previous = queue.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    queue.set(key, current);
    try {
      return await current;
    } finally {
      if (queue.get(key) === current) queue.delete(key);
    }
  }

  async _withIdempotencyLock(callback) {
    return this._serialize(this.idempotencyQueue, 'index', async () => {
      await this._ensureDirectory(this.root);
      await this._ensureDirectory(this.idempotencyRoot, 'idempotency_corrupt');
      return this._withDirectoryConfinement(
        [this.root, this.idempotencyRoot],
        'idempotency_corrupt',
        () => this._withLock(this.idempotencyIndexPath, this.idempotencyLockPath, callback),
      );
    });
  }

  async _withHandleIndexLock(callback) {
    return this._serialize(this.handleIndexQueue, 'index', async () => {
      await this._ensureDirectory(this.root);
      await this._ensureDirectory(this.resultHandlesRoot, 'result_handle_invalid');
      return this._withDirectoryConfinement(
        [this.root, this.resultHandlesRoot],
        'result_handle_invalid',
        () => this._withLock(
          path.join(this.resultHandlesRoot, 'index'),
          path.join(this.resultHandlesRoot, '.index.lock'),
          callback,
        ),
      );
    });
  }

  async _assertCanonicalOperationDirectory(operationId) {
    const operationDirectory = this._operationDirectory(operationId);
    try {
      await this._captureDirectoryIdentities(
        this._operationAncestorPaths(operationId),
        'operation_corrupt',
      );
    } catch (error) {
      if (error.cause?.code === 'ENOENT') throw operationError('operation_not_found', error);
      throw error;
    }
    return operationDirectory;
  }

  async _withOperationLock(operationId, callback, { allowDeleting = false } = {}) {
    assertOperationId(operationId);
    return this._serialize(this.operationQueues, operationId, async () => {
      const operationDirectory = await this._assertCanonicalOperationDirectory(operationId);
      const status = this._statusPath(operationId);
      const lockPath = path.join(operationDirectory, '.operation.lock');
      return this._withDirectoryConfinement(
        this._operationAncestorPaths(operationId),
        'operation_corrupt',
        () => this._withLock(status, lockPath, async () => {
          const record = await this._readPrivateRecord(operationId);
          if (record._deleting && !allowDeleting) throw operationError('operation_not_found');
          return callback(record, operationDirectory);
        }),
      );
    });
  }

  _validatePrivateRecord(record, expectedOperationId) {
    if (!record || Array.isArray(record) || typeof record !== 'object') {
      throw operationError('operation_corrupt');
    }
    exactInputKeys(record, PRIVATE_RECORD_FIELDS, 'operation_corrupt');
    if (record.operationId !== expectedOperationId || !OPERATION_ID_PATTERN.test(record.operationId)) {
      throw operationError('operation_corrupt');
    }
    try {
      assertIdentifier(record.requestId, 'requestId');
      assertIdentifier(record.operationType, 'operationType');
      assertIdentifier(record.requesterAgent, 'requesterAgent');
    } catch (error) {
      throw operationError('operation_corrupt', error);
    }
    if (record.requesterAgent !== this.requesterAgent) throw operationError('operation_corrupt');
    if (!Number.isSafeInteger(record.recordVersion) || record.recordVersion < 1
        || !Number.isSafeInteger(record.eventSequence) || record.eventSequence < 0
        || !Array.from(new Set(['queued', 'running', ...TERMINAL_STATES])).includes(record.state)
        || typeof record.canonicalEvidence !== 'boolean'
        || typeof record._idempotencyKey !== 'string' || !SHA256_PATTERN.test(record._idempotencyKey)
        || typeof record._requestFingerprint !== 'string' || !SHA256_PATTERN.test(record._requestFingerprint)
        || !Number.isSafeInteger(record._eventBytes) || record._eventBytes < 0
        || !Number.isSafeInteger(record._eventOldestSequence) || record._eventOldestSequence < 1
        || typeof record._deleting !== 'boolean') {
      throw operationError('operation_corrupt');
    }
    try {
      assertPlainObject(record.requestParameters);
      assertPlainObject(record.parameters);
      if (record.phase !== null) assertIdentifier(record.phase, 'phase');
      assertIsoOrNull(record.startedAt);
      assertIsoOrNull(record.updatedAt);
      assertIsoOrNull(record.completedAt);
      assertIsoOrNull(record.lastProviderActivityAt);
      assertIsoOrNull(record.lastProgressAt);
      assertIsoOrNull(record.resultExpiresAt);
      assertIsoOrNull(record.resultExpiredAt);
      assertIsoOrNull(record.metadataExpiresAt);
    } catch (error) {
      throw operationError('operation_corrupt', error);
    }
    let expectedKey;
    let expectedFingerprint;
    try {
      expectedKey = buildBrainOperationIdempotencyKey(
        record.requesterAgent,
        record.requestId,
        record.operationType,
      );
      expectedFingerprint = buildRequestFingerprint(
        record.target,
        record.requestParameters,
        record.requesterAgent,
      );
    } catch (error) {
      throw operationError('operation_corrupt', error);
    }
    if (record._idempotencyKey !== expectedKey || record._requestFingerprint !== expectedFingerprint) {
      throw operationError('operation_corrupt');
    }
    if (!Object.hasOwn(record, 'error') || !Object.hasOwn(record, 'sourceEvidence')) {
      throw operationError('operation_corrupt');
    }
    try {
      validateTargetSnapshot(record.target, record.requesterAgent);
      validateTransitionError(record.error, 'operation_corrupt');
      validateSourceEvidence(record.sourceEvidence, 'operation_corrupt');
    } catch (error) {
      if (error?.code === 'operation_corrupt') throw error;
      throw operationError('operation_corrupt', error);
    }
    if (record._worker !== null) assertPlainObjectOrNull(record._worker);
    if (![null, 'inline', 'json-file', 'artifact', 'expired'].includes(record._resultKind)) {
      throw operationError('operation_corrupt');
    }
    if (record._resultKind === null) {
      if (record.result !== null || record.resultHandle !== null || record.resultArtifact !== null
          || record.resultExpiredAt !== null) throw operationError('operation_corrupt');
    } else if (record._resultKind === 'inline') {
      assertPlainObjectOrNull(record.result);
      if (record.result === null || record.resultHandle !== null || record.resultArtifact !== null
          || record.resultExpiredAt !== null) throw operationError('operation_corrupt');
    } else if (record._resultKind === 'json-file' || record._resultKind === 'artifact') {
      if (record.result !== null
          || typeof record.resultHandle !== 'string'
          || !RESULT_HANDLE_PATTERN.test(record.resultHandle)
          || record.resultExpiredAt !== null) {
        throw operationError('operation_corrupt');
      }
      assertResultArtifactMetadata(record.resultArtifact, record._resultKind);
    } else if (record._resultKind === 'expired') {
      if (record.result !== null || record.resultHandle !== null
          || record.resultExpiredAt === null) throw operationError('operation_corrupt');
      if (record.resultArtifact !== null) {
        assertResultArtifactMetadata(record.resultArtifact, 'expired');
      }
    }
    const descriptorIsNull = record.sourcePinDescriptor === null;
    const digestIsNull = record.sourcePinDigest === null;
    if (descriptorIsNull !== digestIsNull
        || (descriptorIsNull && record.sourcePinReleasedAt !== null)) {
      throw operationError('operation_corrupt');
    }
    if (record.sourcePinReleasedAt !== null) {
      const releasedMilliseconds = typeof record.sourcePinReleasedAt === 'string'
        ? Date.parse(record.sourcePinReleasedAt)
        : Number.NaN;
      if (!Number.isFinite(releasedMilliseconds)
          || new Date(releasedMilliseconds).toISOString() !== record.sourcePinReleasedAt
          || !TERMINAL_STATES.has(record.state)) {
        throw operationError('operation_corrupt');
      }
    }
    if (!descriptorIsNull) {
      if ((record.target.domain !== 'brain' && record.target.domain !== 'owned-run')
          || typeof record.target.canonicalRoot !== 'string') {
        throw operationError('operation_corrupt');
      }
      try {
        validateSourcePin(
          record.sourcePinDescriptor,
          record.sourcePinDigest,
          record.target.canonicalRoot,
        );
      } catch (error) {
        throw operationError('operation_corrupt', error);
      }
    }
    const cleanup = record._resultCleanup;
    if (cleanup === undefined) throw operationError('operation_corrupt');
    if (cleanup !== null) {
      if (!cleanup || Array.isArray(cleanup) || typeof cleanup !== 'object') {
        throw operationError('operation_corrupt');
      }
      const cleanupKeys = Reflect.ownKeys(cleanup);
      const validKind = cleanup.kind === null
        || cleanup.kind === 'inline'
        || cleanup.kind === 'json-file'
        || cleanup.kind === 'artifact';
      const handleIsValid = cleanup.handle === null
        || (typeof cleanup.handle === 'string' && RESULT_HANDLE_PATTERN.test(cleanup.handle));
      if (cleanupKeys.some((key) => typeof key !== 'string')
          || cleanupKeys.length !== 3
          || !Object.hasOwn(cleanup, 'handle')
          || !Object.hasOwn(cleanup, 'kind')
          || !Object.hasOwn(cleanup, 'markedAt')
          || !validKind
          || !handleIsValid
          || typeof cleanup.markedAt !== 'string'
          || !Number.isFinite(Date.parse(cleanup.markedAt))
          || !TERMINAL_STATES.has(record.state)
          || record.result !== null
          || record.resultHandle !== null
          || record.resultExpiredAt !== cleanup.markedAt
          || record._resultKind !== 'expired'
          || ((cleanup.kind === 'json-file' || cleanup.kind === 'artifact') && cleanup.handle === null)
          || ((cleanup.kind === null || cleanup.kind === 'inline') && cleanup.handle !== null)) {
        throw operationError('operation_corrupt');
      }
    }
    return record;
  }

  async _readPrivateRecord(operationId) {
    assertOperationId(operationId);
    const operationDirectory = this._operationDirectory(operationId);
    const statusFile = this._statusPath(operationId);
    let ancestorIdentities;
    try {
      ancestorIdentities = await this._captureDirectoryIdentities(
        this._operationAncestorPaths(operationId),
        'operation_corrupt',
      );
    } catch (error) {
      if (error.cause?.code === 'ENOENT') throw operationError('operation_not_found', error);
      throw error;
    }
    let bytes;
    try {
      bytes = await this._readSecureRegularFile(
        statusFile,
        undefined,
        'operation_corrupt',
        'operation_not_found',
      );
    } catch (error) {
      throw error;
    }
    await this._verifyDirectoryIdentities(ancestorIdentities, 'operation_corrupt');
    let record;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw operationError('operation_corrupt', error);
    }
    return this._validatePrivateRecord(record, operationId);
  }

  async _readIndex() {
    let source;
    try {
      source = (await this._readSecureRegularFile(
        this.idempotencyIndexPath,
        undefined,
        'idempotency_corrupt',
        'index_not_found',
      )).toString('utf8');
    } catch (error) {
      if (error.code === 'index_not_found') {
        return { index: { version: 1, entries: {} }, syntaxCorrupt: false };
      }
      throw error;
    }
    let index;
    try {
      index = JSON.parse(source);
    } catch {
      return { index: { version: 1, entries: {} }, syntaxCorrupt: true };
    }
    if (!index || Array.isArray(index) || index.version !== 1
        || !index.entries || Array.isArray(index.entries) || typeof index.entries !== 'object') {
      return { index: { version: 1, entries: {} }, syntaxCorrupt: true };
    }
    const mappedOperations = new Set();
    for (const [key, entry] of Object.entries(index.entries)) {
      if (!SHA256_PATTERN.test(key)
          || !entry || Array.isArray(entry) || typeof entry !== 'object'
          || !OPERATION_ID_PATTERN.test(entry.operationId)
          || entry.requesterAgent !== this.requesterAgent
          || !SHA256_PATTERN.test(entry.requestFingerprint)) {
        throw operationError('idempotency_corrupt');
      }
      if (mappedOperations.has(entry.operationId)) throw operationError('idempotency_corrupt');
      mappedOperations.add(entry.operationId);
    }
    return { index, syntaxCorrupt: false };
  }

  async _listOperationIds() {
    let entries;
    try {
      await this._captureDirectoryIdentities([this.root, this.operationsRoot], 'operation_corrupt');
      entries = await fsp.readdir(this.operationsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.cause?.code === 'ENOENT') return [];
      throw error;
    }
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !OPERATION_ID_PATTERN.test(entry.name)) continue;
      const fullPath = path.join(this.operationsRoot, entry.name);
      const stat = await fsp.lstat(fullPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) ids.push(entry.name);
    }
    return ids.sort();
  }

  async _scanClaims() {
    const claims = new Map();
    for (const operationId of await this._listOperationIds()) {
      let record;
      try {
        record = await this._readPrivateRecord(operationId);
      } catch (error) {
        if (error.code === 'operation_not_found') continue;
        throw operationError('idempotency_corrupt', error);
      }
      if (record._deleting) continue;
      if (claims.has(record._idempotencyKey)) throw operationError('idempotency_corrupt');
      claims.set(record._idempotencyKey, record);
    }
    return claims;
  }

  _indexEntry(record) {
    return {
      operationId: record.operationId,
      requesterAgent: record.requesterAgent,
      requestFingerprint: record._requestFingerprint,
    };
  }

  async _rebuildIndexFromClaims(claims, stage = 'before_idempotency_index_rename') {
    const entries = {};
    for (const [key, record] of claims) entries[key] = this._indexEntry(record);
    const index = { version: 1, entries };
    await this._writeJson(this.idempotencyIndexPath, index, stage);
    return index;
  }

  async _lookupAndRepairIdempotency(key, expectedFingerprint = null) {
    let { index, syntaxCorrupt } = await this._readIndex();
    let claims = null;
    if (syntaxCorrupt) {
      claims = await this._scanClaims();
      index = await this._rebuildIndexFromClaims(claims);
    }
    const entry = index.entries[key];
    let record = null;
    if (entry) {
      try {
        record = await this._readPrivateRecord(entry.operationId);
      } catch (error) {
        throw operationError('idempotency_corrupt', error);
      }
      if (record._idempotencyKey !== key
          || record._requestFingerprint !== entry.requestFingerprint
          || record.requesterAgent !== entry.requesterAgent) {
        throw operationError('idempotency_corrupt');
      }
      claims = await this._scanClaims();
      if (claims.get(key)?.operationId !== record.operationId) {
        throw operationError('idempotency_corrupt');
      }
    } else {
      claims ??= await this._scanClaims();
      record = claims.get(key) || null;
      if (record) {
        if (Object.entries(index.entries).some(([indexedKey, indexedEntry]) =>
          indexedKey !== key && indexedEntry.operationId === record.operationId)) {
          throw operationError('idempotency_corrupt');
        }
        index.entries[key] = this._indexEntry(record);
        await this._writeJson(this.idempotencyIndexPath, index, 'before_idempotency_index_rename');
      }
    }
    if (record && expectedFingerprint && record._requestFingerprint !== expectedFingerprint) {
      throw operationError('idempotency_conflict');
    }
    return { record, index };
  }

  _randomOpaque(prefix) {
    const bytes = this.randomBytes(24);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 24) throw operationError('random_source_invalid');
    const encoded = bytes.toString('base64url');
    if (encoded.length !== 32) throw operationError('random_source_invalid');
    return `${prefix}${encoded}`;
  }

  async _allocateOperationDirectory() {
    await this._ensureDirectory(this.root);
    await this._ensureDirectory(this.operationsRoot, 'operation_corrupt');
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const operationId = this._randomOpaque('brop_');
      const directory = this._operationDirectory(operationId);
      try {
        await fsp.mkdir(directory, { recursive: false, mode: 0o700 });
        await this._syncDirectory(this.operationsRoot);
        return { operationId, directory };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw operationError('operation_id_collision');
  }

  _initialRecord(input, operationId, now) {
    return {
      operationId,
      requestId: input.requestId,
      operationType: input.operationType,
      requestParameters: input.requestParameters,
      parameters: input.parameters,
      canonicalEvidence: input.canonicalEvidence,
      recordVersion: 1,
      eventSequence: 0,
      requesterAgent: input.requesterAgent,
      target: input.target,
      state: 'queued',
      phase: null,
      startedAt: null,
      updatedAt: isoTime(now),
      completedAt: null,
      lastProviderActivityAt: null,
      lastProgressAt: null,
      result: null,
      resultHandle: null,
      resultArtifact: null,
      error: null,
      sourceEvidence: null,
      sourcePinDescriptor: null,
      sourcePinDigest: null,
      sourcePinReleasedAt: null,
      resultExpiresAt: null,
      resultExpiredAt: null,
      metadataExpiresAt: null,
      _idempotencyKey: input.idempotencyKey,
      _requestFingerprint: input.requestFingerprint,
      _worker: null,
      _resultKind: null,
      _resultCleanup: null,
      _eventBytes: 0,
      _eventOldestSequence: 1,
      _deleting: false,
    };
  }

  async create(rawInput) {
    const input = validateCreateInput(rawInput, this.requesterAgent);
    return this._withIdempotencyLock(async () => {
      const lookup = await this._lookupAndRepairIdempotency(
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (lookup.record) return { record: projectPublicRecord(lookup.record), created: false };

      const { operationId, directory } = await this._allocateOperationDirectory();
      const record = this._initialRecord(input, operationId, this._nowMs());
      try {
        await this._withDirectoryConfinement(
          [this.root, this.operationsRoot, directory],
          'operation_corrupt',
          () => this._writeJson(
            path.join(directory, 'status.json'),
            record,
            'before_initial_status_rename',
          ),
        );
      } catch (error) {
        await fsp.rm(directory, { recursive: true, force: true });
        await this._syncDirectory(this.operationsRoot);
        throw error;
      }

      await this._inject('after_initial_status_commit', { operationId });
      lookup.index.entries[input.idempotencyKey] = this._indexEntry(record);
      await this._writeJson(
        this.idempotencyIndexPath,
        lookup.index,
        'before_idempotency_index_rename',
      );
      return { record: projectPublicRecord(record), created: true };
    });
  }

  async findByIdempotencyKey(key) {
    if (typeof key !== 'string' || !SHA256_PATTERN.test(key)) {
      throw operationError('idempotency_key_invalid');
    }
    return this._withIdempotencyLock(async () => {
      const { record } = await this._lookupAndRepairIdempotency(key);
      return record ? projectPublicRecord(record) : null;
    });
  }

  async get(operationId) {
    return projectPublicRecord(await this._readPrivateRecord(operationId));
  }

  async getWorker(operationId) {
    const record = await this._readPrivateRecord(operationId);
    if (record._worker === null) return null;
    const worker = safeJsonClone(record._worker, 'operation_corrupt');
    if (!worker || Array.isArray(worker) || typeof worker !== 'object') {
      throw operationError('operation_corrupt');
    }
    return worker;
  }

  async ensureScratchDirectory(operationId) {
    assertOperationId(operationId);
    return this._withOperationLock(operationId, async (record) => {
      if (TERMINAL_STATES.has(record.state)) throw operationError('operation_terminal');
      const scratchPath = this._scratchPath(operationId);
      try {
        const existing = await fsp.lstat(scratchPath);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw operationError('scratch_corrupt');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error.code === 'scratch_corrupt') throw error;
          throw operationError('scratch_corrupt', error);
        }
        try {
          await fsp.mkdir(scratchPath, { recursive: false, mode: 0o700 });
          await this._syncDirectory(this._operationDirectory(operationId));
        } catch (createError) {
          if (createError.code !== 'EEXIST') throw createError;
          const raced = await fsp.lstat(scratchPath);
          if (!raced.isDirectory() || raced.isSymbolicLink()) {
            throw operationError('scratch_corrupt');
          }
        }
      }
      return scratchPath;
    });
  }

  async list() {
    const records = [];
    for (const operationId of await this._listOperationIds()) {
      try {
        const record = await this._readPrivateRecord(operationId);
        if (!record._deleting) records.push(projectPublicRecord(record));
      } catch (error) {
        if (error.code !== 'operation_not_found') throw error;
      }
    }
    return records.sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.operationId.localeCompare(right.operationId));
  }

  async listNonterminal() {
    return (await this.list()).filter((record) => !TERMINAL_STATES.has(record.state));
  }

  async listPinsPendingRelease() {
    return (await this.list()).filter((record) =>
      TERMINAL_STATES.has(record.state)
      && record.sourcePinDescriptor !== null
      && record.sourcePinReleasedAt === null);
  }

  _assertMutable(record, expectedVersion) {
    if (TERMINAL_STATES.has(record.state)) throw operationError('operation_terminal');
    assertExpectedVersion(expectedVersion);
    if (record.recordVersion !== expectedVersion) throw operationError('version_conflict');
  }

  async _readEventRows(record, attempt = 0, confined = false) {
    if (!confined) {
      try {
        return await this._withDirectoryConfinement(
          this._operationAncestorPaths(record.operationId),
          'operation_corrupt',
          () => this._readEventRows(record, attempt, true),
        );
      } catch (error) {
        this.eventCache.delete(record.operationId);
        throw error;
      }
    }

    const cached = this.eventCache.get(record.operationId);
    if (cached?.eventSequence === record.eventSequence) {
      const currentIdentity = await this._eventFileIdentity(record.operationId);
      if (sameFileIdentity(cached.fileIdentity, currentIdentity)) return cached.rows;
    }
    const identityBefore = await this._eventFileIdentity(record.operationId);
    let source;
    try {
      source = (await this._readSecureRegularFile(
        this._eventPath(record.operationId),
        undefined,
        'operation_corrupt',
        'event_not_found',
      )).toString('utf8');
    } catch (error) {
      if (error.code === 'event_not_found') {
        const identityAfterMissing = await this._eventFileIdentity(record.operationId);
        if (!sameFileIdentity(identityBefore, identityAfterMissing)) {
          if (attempt >= 7) throw operationError('operation_corrupt');
          return this._readEventRows(record, attempt + 1, true);
        }
        this.eventCache.set(record.operationId, {
          eventSequence: record.eventSequence,
          rows: [],
          rawCount: 0,
          fileIdentity: null,
        });
        return [];
      }
      if (error.code === 'operation_corrupt') {
        const identityAfterFailure = await this._eventFileIdentity(record.operationId);
        if (!sameFileIdentity(identityBefore, identityAfterFailure) && attempt < 7) {
          return this._readEventRows(record, attempt + 1, true);
        }
      }
      throw error;
    }
    const lines = source.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const rows = [];
    let previousSequence = 0;
    for (const line of lines) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw operationError('operation_corrupt', error);
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)
          || event.operationId !== record.operationId
          || !Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
        throw operationError('operation_corrupt');
      }
      previousSequence = event.sequence;
      if (event.sequence <= record.eventSequence) rows.push(event);
    }
    const identityAfter = await this._eventFileIdentity(record.operationId);
    if (!sameFileIdentity(identityBefore, identityAfter)) {
      if (attempt >= 7) throw operationError('operation_corrupt');
      return this._readEventRows(record, attempt + 1, true);
    }
    this.eventCache.set(record.operationId, {
      eventSequence: record.eventSequence,
      rows,
      rawCount: lines.length,
      fileIdentity: identityAfter,
    });
    return rows;
  }

  _compactEvents(events) {
    const retained = [...events];
    const overLimit = () => retained.length > this.eventMaxCount
      || eventBytes(retained) > this.eventMaxBytes;
    while (overLimit() && retained.length > 0) {
      let index = retained.findIndex((event, candidate) =>
        isNoisyEvent(event) && candidate < retained.length - 1);
      if (index < 0) index = retained.findIndex((event) => !isImportantEvent(event));
      if (index < 0) {
        index = retained.findIndex((event, candidate) =>
          retained.slice(candidate + 1).some((later) => later.type === event.type));
      }
      if (index < 0) index = 0;
      retained.splice(index, 1);
    }
    return retained;
  }

  _normalizeEvent(record, rawEvent, sequence, now) {
    const event = safeJsonClone(rawEvent, 'event_invalid');
    if (!event || Array.isArray(event) || typeof event !== 'object') throw operationError('event_invalid');
    if (Object.hasOwn(event, 'sequence') || Object.hasOwn(event, 'operationId')) {
      throw operationError('event_invalid');
    }
    for (const field of EVENT_PRIVATE_PATH_FIELDS) {
      if (Object.hasOwn(event, field)) throw operationError('event_invalid');
    }
    assertIdentifier(event.type, 'eventType');
    if (event.type === 'phase') {
      try {
        assertIdentifier(event.phase, 'phase');
      } catch (error) {
        throw operationError('event_invalid', error);
      }
    }
    let normalized = {
      ...event,
      operationId: record.operationId,
      sequence,
      at: isoTime(now),
    };
    if (event.type === 'heartbeat') {
      normalized = {
        ...normalized,
        operationId: record.operationId,
        sequence: record.eventSequence,
        eventSequence: record.eventSequence,
        recordVersion: record.recordVersion,
        state: record.state,
        phase: record.phase,
        updatedAt: record.updatedAt,
        lastProviderActivityAt: record.lastProviderActivityAt,
        lastProgressAt: record.lastProgressAt,
        at: record.updatedAt,
      };
    }
    if (Buffer.byteLength(eventLine(normalized), 'utf8') > this.eventMaxBytes) {
      throw operationError('event_invalid');
    }
    return normalized;
  }

  async _writeEventAndStatus(
    current,
    next,
    event,
    statusStage = 'before_status_rename',
    statusAfterRenameStage = null,
  ) {
    let rows = await this._readEventRows(current);
    const existingPath = this._eventPath(current.operationId);
    const allRowsCount = this.eventCache.get(current.operationId)?.rawCount ?? rows.length;
    if (allRowsCount !== rows.length && rows.length > 0) {
      await writeFileDurable(existingPath, rows.map(eventLine).join(''), {
        encoding: 'utf8', mode: 0o600, strictDirectorySync: true,
      });
    } else if (allRowsCount !== rows.length && rows.length === 0) {
      await fsp.rm(existingPath, { force: true });
    }

    const proposed = [...rows, event];
    const retained = this._compactEvents(proposed);
    try {
      if (retained.length === proposed.length) {
        if (typeof appendJsonlDurable === 'function') {
          await appendJsonlDurable(existingPath, event, { strictDirectorySync: true });
        } else {
          const handle = await fsp.open(existingPath, 'a', 0o600);
          try {
            await handle.writeFile(eventLine(event), 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      } else {
        await writeFileDurable(existingPath, retained.map(eventLine).join(''), {
          encoding: 'utf8', mode: 0o600, strictDirectorySync: true,
        });
      }
      next._eventBytes = eventBytes(retained);
      next._eventOldestSequence = oldestContiguousSequence(retained, next.eventSequence);
      await this._writeJson(
        this._statusPath(current.operationId),
        next,
        statusStage,
        statusAfterRenameStage,
      );
      this.eventCache.set(current.operationId, {
        eventSequence: next.eventSequence,
        rows: retained,
        rawCount: retained.length,
        fileIdentity: await this._eventFileIdentity(current.operationId),
      });
    } catch (error) {
      this.eventCache.delete(current.operationId);
      throw error;
    }
  }

  async _commitMutation(current, mutate, rawEvent, statusStage, statusAfterRenameStage) {
    const now = this._nowMs();
    const next = safeJsonClone(current, 'operation_corrupt');
    mutate(next, now);
    next.recordVersion = current.recordVersion + 1;
    next.eventSequence = current.eventSequence + 1;
    next.updatedAt = isoTime(now);
    const event = this._normalizeEvent(next, rawEvent, next.eventSequence, now);
    await this._writeEventAndStatus(
      current,
      next,
      event,
      statusStage,
      statusAfterRenameStage,
    );
    return next;
  }

  async appendEvent(operationId, rawEvent) {
    assertOperationId(operationId);
    safeJsonClone(rawEvent, 'event_invalid');
    return this._withOperationLock(operationId, async (record) => {
      if (TERMINAL_STATES.has(record.state)) throw operationError('operation_terminal');
      const next = await this._commitMutation(record, (draft, now) => {
        if (rawEvent.type === 'provider_activity') draft.lastProviderActivityAt = isoTime(now);
        if (rawEvent.type === 'progress' || rawEvent.type === 'progress_update') {
          draft.lastProgressAt = isoTime(now);
        }
        if (rawEvent.type === 'phase') draft.phase = rawEvent.phase;
      }, rawEvent);
      return projectPublicRecord(next);
    });
  }

  async readEvents(operationId, after = 0) {
    assertOperationId(operationId);
    if (!Number.isSafeInteger(after) || after < 0) throw operationError('event_cursor_invalid');
    const record = await this._readPrivateRecord(operationId);
    const rows = await this._readEventRows(record);
    const oldestSequence = oldestContiguousSequence(rows, record.eventSequence);
    const latestSequence = record.eventSequence;
    const output = rows.filter((event) => event.sequence > after).map((event) => safeJsonClone(event));
    if (after < oldestSequence - 1 && latestSequence > 0) {
      output.unshift({
        type: 'event_gap',
        operationId,
        oldestSequence,
        latestSequence,
      });
    }
    return output;
  }

  async transition(operationId, transition) {
    assertOperationId(operationId);
    exactInputKeys(transition, ['expectedVersion', 'state', 'phase', 'error', 'sourceEvidence'], 'transition_invalid');
    assertExpectedVersion(transition.expectedVersion);
    if (transition.phase !== undefined && transition.phase !== null) assertIdentifier(transition.phase, 'phase');
    const hasError = Object.hasOwn(transition, 'error');
    const hasSourceEvidence = Object.hasOwn(transition, 'sourceEvidence');
    const errorValue = hasError
      ? validateTransitionError(transition.error)
      : undefined;
    const evidenceValue = hasSourceEvidence
      ? validateSourceEvidence(transition.sourceEvidence)
      : undefined;
    return this._withOperationLock(operationId, async (record) => {
      if (TERMINAL_STATES.has(record.state)) throw operationError('operation_terminal');
      if (record.recordVersion !== transition.expectedVersion) throw operationError('version_conflict');
      assertTransition(record.state, transition.state);
      const next = await this._commitMutation(record, (draft, now) => {
        draft.state = transition.state;
        if (transition.phase !== undefined) draft.phase = transition.phase;
        if (errorValue !== undefined) draft.error = errorValue;
        if (evidenceValue !== undefined) draft.sourceEvidence = evidenceValue;
        if (transition.state === 'running' && draft.startedAt === null) draft.startedAt = isoTime(now);
        if (TERMINAL_STATES.has(transition.state)) {
          draft.completedAt = isoTime(now);
          draft.resultExpiresAt = isoTime(now + RESULT_RETENTION_MS);
          draft.metadataExpiresAt = isoTime(now + METADATA_RETENTION_MS);
        }
      }, { type: 'state', state: transition.state, phase: transition.phase ?? record.phase });
      return projectPublicRecord(next);
    });
  }

  async setWorker(operationId, input) {
    assertOperationId(operationId);
    exactInputKeys(input, ['expectedVersion', 'worker'], 'worker_invalid');
    assertExpectedVersion(input.expectedVersion);
    const worker = safeJsonClone(input.worker, 'worker_invalid');
    if (!worker || Array.isArray(worker) || typeof worker !== 'object') throw operationError('worker_invalid');
    return this._withOperationLock(operationId, async (record) => {
      if (record._worker !== null) throw operationError('worker_conflict');
      this._assertMutable(record, input.expectedVersion);
      const next = await this._commitMutation(record, (draft) => {
        draft._worker = worker;
      }, { type: 'worker_assigned' });
      return projectPublicRecord(next);
    });
  }

  async attachSourcePin(operationId, input) {
    assertOperationId(operationId);
    exactInputKeys(input, ['expectedVersion', 'descriptor', 'digest'], 'source_pin_invalid');
    assertExpectedVersion(input.expectedVersion);
    return this._withOperationLock(operationId, async (record) => {
      if (record.sourcePinDescriptor !== null || record.sourcePinDigest !== null) {
        let identical = false;
        try {
          identical = canonicalJson(record.sourcePinDescriptor) === canonicalJson(input.descriptor)
            && record.sourcePinDigest === input.digest;
        } catch {}
        if (identical) return projectPublicRecord(record);
        throw operationError('source_pin_conflict');
      }
      this._assertMutable(record, input.expectedVersion);
      if (record.target.domain !== 'brain' && record.target.domain !== 'owned-run') {
        throw operationError('source_pin_invalid');
      }
      const descriptor = validateSourcePin(input.descriptor, input.digest, record.target.canonicalRoot);
      const next = await this._commitMutation(record, (draft) => {
        draft.sourcePinDescriptor = descriptor;
        draft.sourcePinDigest = input.digest;
      }, {
        type: 'source_pin_attached',
        sourcePinDigest: input.digest,
      }, 'before_source_pin_status_rename');
      return projectPublicRecord(next);
    });
  }

  async _allocateHandleIndex(operationId, requesterAgent) {
    return this._withHandleIndexLock(async () => {
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const handle = this._randomOpaque('brres_');
        const hash = this._resultHandleHash(handle);
        const indexPath = this._resultHandleIndexPath(hash);
        try {
          await fsp.lstat(indexPath);
          continue;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const mapping = { handleSha256: hash, operationId, requesterAgent };
        try {
          await this._writeJson(indexPath, mapping, 'before_result_handle_index_rename');
        } catch (error) {
          await fsp.rm(indexPath, { force: true }).catch(() => {});
          await this._syncDirectory(this.resultHandlesRoot).catch(() => {});
          throw error;
        }
        return handle;
      }
      throw operationError('result_handle_collision');
    });
  }

  async _removeHandleIndex(handle) {
    if (typeof handle !== 'string' || !RESULT_HANDLE_PATTERN.test(handle)) return;
    const hash = this._resultHandleHash(handle);
    await this._withHandleIndexLock(() => this._withDirectoryConfinement(
      [this.root, this.resultHandlesRoot],
      'result_handle_invalid',
      async () => {
        await fsp.rm(this._resultHandleIndexPath(hash), { force: true });
        await this._syncDirectory(this.resultHandlesRoot);
      },
    ));
  }

  async _authorizeResult(record, requesterAgent, resultHandle) {
    assertIdentifier(requesterAgent, 'requesterAgent');
    if (requesterAgent !== record.requesterAgent) throw operationError('access_denied');
    assertResultHandle(resultHandle);
    if (typeof record.resultHandle !== 'string' || !RESULT_HANDLE_PATTERN.test(record.resultHandle)) {
      throw operationError('result_handle_invalid');
    }
    const supplied = this._resultHandleHash(resultHandle);
    const expected = this._resultHandleHash(record.resultHandle);
    if (!timingSafeHexEqual(supplied, expected)) throw operationError('result_handle_invalid');
    let mapping;
    try {
      const indexPath = this._resultHandleIndexPath(expected);
      mapping = await this._withDirectoryConfinement(
        [this.root, this.resultHandlesRoot],
        'result_handle_invalid',
        async () => JSON.parse((await this._readSecureRegularFile(
          indexPath,
          undefined,
          'result_handle_invalid',
          'result_handle_invalid',
        )).toString('utf8')),
      );
    } catch (error) {
      throw operationError('result_handle_invalid', error);
    }
    if (!mapping || mapping.handleSha256 !== expected
        || mapping.operationId !== record.operationId
        || mapping.requesterAgent !== record.requesterAgent) {
      throw operationError('result_handle_invalid');
    }
  }

  async _readSecureRegularFile(
    filePath,
    expectedBytes,
    code = 'result_corrupt',
    missingCode = null,
  ) {
    let pathStat;
    let handle;
    try {
      pathStat = await fsp.lstat(filePath, { bigint: true });
      if (!pathStat.isFile() || pathStat.isSymbolicLink()
          || (expectedBytes !== undefined && pathStat.size !== BigInt(expectedBytes))) {
        throw operationError(code);
      }
      handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()
          || opened.dev !== pathStat.dev
          || opened.ino !== pathStat.ino
          || opened.size !== pathStat.size
          || opened.mtimeNs !== pathStat.mtimeNs
          || opened.ctimeNs !== pathStat.ctimeNs) {
        throw operationError(code);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (after.size !== opened.size
          || after.mtimeNs !== opened.mtimeNs
          || after.ctimeNs !== opened.ctimeNs) {
        throw operationError(code);
      }
      return bytes;
    } catch (error) {
      if (error?.code === 'ENOENT' && missingCode) throw operationError(missingCode, error);
      if (error?.code === code) throw error;
      throw operationError(code, error);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  _assertNoResult(record) {
    if (record._resultKind !== null
        || record.result !== null
        || record.resultHandle !== null
        || record.resultArtifact !== null) {
      throw operationError('result_conflict');
    }
  }

  async _isPublishedResult(operationId, handle, kind) {
    if (typeof handle !== 'string') return false;
    try {
      const record = await this._readPrivateRecord(operationId);
      return record.resultHandle === handle && record._resultKind === kind;
    } catch {
      return null;
    }
  }

  _durabilityUncertain(error) {
    const uncertain = operationError('durability_uncertain', error);
    uncertain.published = true;
    return uncertain;
  }

  async _assertResultPathAbsent(filePath) {
    try {
      await fsp.lstat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw operationError('result_conflict', error);
    }
    throw operationError('result_conflict');
  }

  async _inspectExactOrphanJson(operationId, expectedBytes, expectedSha256) {
    const resultPath = this._resultJsonPath(operationId);
    try {
      await fsp.lstat(resultPath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw operationError('result_conflict', error);
    }
    return this._withDirectoryConfinement(
      this._operationAncestorPaths(operationId),
      'result_conflict',
      async () => {
        const existing = await this._readSecureRegularFile(
          resultPath,
          expectedBytes.length,
          'result_conflict',
        );
        const digest = crypto.createHash('sha256').update(existing).digest('hex');
        if (digest !== expectedSha256 || !existing.equals(expectedBytes)) {
          throw operationError('result_conflict');
        }
        return true;
      },
    );
  }

  async setResult(operationId, input) {
    assertOperationId(operationId);
    exactInputKeys(input, ['expectedVersion', 'result'], 'result_invalid');
    assertExpectedVersion(input.expectedVersion);
    let serialized;
    let normalized;
    try {
      normalized = validateResultObject(input.result);
      serialized = canonicalJson(normalized);
    } catch (error) {
      throw operationError('result_invalid', error);
    }
    const serializedBytes = Buffer.from(serialized, 'utf8');
    const bytes = serializedBytes.length;
    const sha256 = crypto.createHash('sha256').update(serializedBytes).digest('hex');
    return this._withOperationLock(operationId, async (record) => {
      this._assertMutable(record, input.expectedVersion);
      this._assertNoResult(record);
      await this._removeOperationPublicationTemps(operationId);
      await this._assertResultPathAbsent(this._resultArtifactPath(operationId));
      const exactOrphan = await this._inspectExactOrphanJson(
        operationId,
        serializedBytes,
        sha256,
      );
      if (bytes <= INLINE_RESULT_LIMIT_BYTES) {
        if (exactOrphan) throw operationError('result_conflict');
        const next = await this._commitMutation(record, (draft) => {
          draft.result = normalized;
          draft._resultKind = 'inline';
        }, { type: 'result_ready', storage: 'inline', bytes });
        return projectPublicRecord(next);
      }

      const resultPath = this._resultJsonPath(operationId);
      let handle = null;
      let handleWritten = false;
      let resultRenamedThisAttempt = false;
      try {
        if (exactOrphan) {
          await this._removeOrphanHandleIndexes(operationId, record.requesterAgent);
        } else {
          await this._withDirectoryConfinement(
            this._operationAncestorPaths(operationId),
            'result_corrupt',
            () => writeFileDurable(resultPath, serialized, {
              encoding: 'utf8',
              mode: 0o600,
              strictDirectorySync: true,
              beforeRename: () => this._inject('before_result_rename', { operationId }),
              afterRename: () => { resultRenamedThisAttempt = true; },
            }),
          );
        }
        handle = await this._allocateHandleIndex(operationId, record.requesterAgent);
        handleWritten = true;
        const next = await this._commitMutation(record, (draft) => {
          draft.result = null;
          draft.resultHandle = handle;
          draft.resultArtifact = {
            mediaType: 'application/json',
            contentEncoding: 'identity',
            bytes,
            sha256,
          };
          draft._resultKind = 'json-file';
        }, { type: 'result_ready', storage: 'file', bytes, sha256 }, undefined,
        'after_result_status_rename');
        return projectPublicRecord(next);
      } catch (error) {
        const published = await this._isPublishedResult(operationId, handle, 'json-file');
        if (published !== false) {
          throw this._durabilityUncertain(error);
        }
        if (handleWritten) await this._removeHandleIndex(handle).catch(() => {});
        if (resultRenamedThisAttempt) {
          await this._withDirectoryConfinement(
            this._operationAncestorPaths(operationId),
            'result_corrupt',
            async () => {
              await fsp.rm(resultPath, { force: true });
              await this._syncDirectory(this._operationDirectory(operationId));
            },
          ).catch(() => {});
        }
        throw error;
      }
    });
  }

  async getResult(operationId, input) {
    assertOperationId(operationId);
    exactInputKeys(input, ['requesterAgent', 'resultHandle'], 'result_handle_invalid');
    const record = await this._readPrivateRecord(operationId);
    if (record.resultExpiredAt !== null || record._resultKind === 'expired') {
      throw operationError('result_expired');
    }
    assertIdentifier(input.requesterAgent, 'requesterAgent');
    if (input.requesterAgent !== record.requesterAgent) throw operationError('access_denied');
    if (record._resultKind === 'inline') return safeJsonClone(record.result, 'operation_corrupt');
    if (record._resultKind === null) throw operationError('result_unavailable');
    await this._authorizeResult(record, input.requesterAgent, input.resultHandle);
    if (record._resultKind === 'artifact') {
      return {
        result: null,
        resultHandle: record.resultHandle,
        resultArtifact: safeJsonClone(record.resultArtifact, 'operation_corrupt'),
      };
    }
    if (record._resultKind !== 'json-file') throw operationError('result_unavailable');
    let bytes;
    try {
      bytes = await this._withDirectoryConfinement(
        this._operationAncestorPaths(operationId),
        'result_corrupt',
        () => this._readSecureRegularFile(
          this._resultJsonPath(operationId),
          record.resultArtifact?.bytes,
          'result_corrupt',
        ),
      );
    } catch (error) {
      throw operationError('result_corrupt', error);
    }
    if (bytes.length !== record.resultArtifact?.bytes
        || crypto.createHash('sha256').update(bytes).digest('hex') !== record.resultArtifact?.sha256) {
      throw operationError('result_corrupt');
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw operationError('result_corrupt', error);
    }
  }

  async _copyArtifactIntoStore(
    operationId,
    scratchPath,
    expectedBytes,
    expectedSha256,
    adoptionState,
  ) {
    if (typeof scratchPath !== 'string'
        || scratchPath.includes('\0')
        || !path.isAbsolute(scratchPath)
        || path.normalize(scratchPath) !== scratchPath) {
      throw operationError('result_artifact_invalid');
    }
    const scratchRoot = this._scratchPath(operationId);
    const relative = path.relative(scratchRoot, scratchPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw operationError('result_artifact_invalid');
    }

    const components = relative.split(path.sep);
    const directoryPaths = [...this._operationAncestorPaths(operationId), scratchRoot];
    let cursor = scratchRoot;
    try {
      for (let index = 0; index < components.length - 1; index += 1) {
        cursor = path.join(cursor, components[index]);
        const componentStat = await fsp.lstat(cursor, { bigint: true });
        if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) {
          throw operationError('result_artifact_invalid');
        }
        directoryPaths.push(cursor);
      }
    } catch (error) {
      if (error?.code === 'result_artifact_invalid') throw error;
      throw operationError('result_artifact_invalid', error);
    }

    let sourcePathStat;
    try {
      sourcePathStat = await fsp.lstat(scratchPath, { bigint: true });
    } catch (error) {
      throw operationError('result_artifact_invalid', error);
    }
    if (!sourcePathStat.isFile() || sourcePathStat.isSymbolicLink() || sourcePathStat.nlink !== 1n) {
      throw operationError('result_artifact_invalid');
    }
    const sourcePathIdentity = fileIdentity(sourcePathStat);
    const ancestorIdentities = await this._captureDirectoryIdentities(
      directoryPaths,
      'result_artifact_invalid',
    );

    const artifactPath = this._resultArtifactPath(operationId);
    try {
      await fsp.lstat(artifactPath);
      throw operationError('result_conflict');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const tempPath = path.join(
      this._operationDirectory(operationId),
      `.result.artifact.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
    );
    const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const destinationFlags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    let sourceHandle;
    let destinationHandle;
    let renamed = false;
    let finalSourceIdentity;
    try {
      sourceHandle = await fsp.open(scratchPath, sourceFlags);
      const opened = await sourceHandle.stat({ bigint: true });
      const openedIdentity = fileIdentity(opened);
      if (!opened.isFile() || opened.nlink !== 1n
          || !sameArtifactSourceIdentity(openedIdentity, sourcePathIdentity)) {
        throw operationError('result_artifact_invalid');
      }

      destinationHandle = await fsp.open(tempPath, destinationFlags, 0o600);
      const destinationOpened = await destinationHandle.stat({ bigint: true });
      if (!destinationOpened.isFile() || destinationOpened.nlink !== 1n) {
        throw operationError('result_artifact_invalid');
      }

      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const stream = sourceHandle.createReadStream({ autoClose: false, start: 0 });
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES) {
          stream.destroy();
          throw operationError('result_artifact_invalid');
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await destinationHandle.write(chunk, offset, chunk.length - offset, null);
          if (!Number.isSafeInteger(written.bytesWritten) || written.bytesWritten <= 0) {
            throw operationError('result_artifact_invalid');
          }
          offset += written.bytesWritten;
        }
      }
      const digest = hash.digest('hex');
      if (bytes !== expectedBytes || digest !== expectedSha256) {
        throw operationError('result_artifact_invalid');
      }
      await destinationHandle.sync();
      await this._inject('after_artifact_verify', { operationId, scratchPath });

      const openedAfter = await sourceHandle.stat({ bigint: true });
      const pathAfter = await fsp.lstat(scratchPath, { bigint: true });
      const openedAfterIdentity = fileIdentity(openedAfter);
      const pathAfterIdentity = fileIdentity(pathAfter);
      if (!openedAfter.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
          || openedAfter.nlink !== 1n || pathAfter.nlink !== 1n
          || !sameArtifactSourceIdentity(openedAfterIdentity, sourcePathIdentity)
          || !sameArtifactSourceIdentity(pathAfterIdentity, sourcePathIdentity)) {
        throw operationError('result_artifact_invalid');
      }
      finalSourceIdentity = pathAfterIdentity;
      await this._verifyDirectoryIdentities(ancestorIdentities, 'result_artifact_invalid');

      await destinationHandle.close();
      destinationHandle = null;
      await this._inject('before_artifact_rename', { operationId });
      await this._verifyDirectoryIdentities(ancestorIdentities, 'result_artifact_invalid');
      await fsp.rename(tempPath, artifactPath);
      renamed = true;
      adoptionState.artifactRenamed = true;
      await this._syncDirectory(this._operationDirectory(operationId));

      const published = await fsp.lstat(artifactPath, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n
          || published.size !== BigInt(expectedBytes)
          || (published.dev === sourcePathStat.dev && published.ino === sourcePathStat.ino)) {
        throw operationError('result_artifact_invalid');
      }
      await this._verifyDirectoryIdentities(ancestorIdentities, 'result_artifact_invalid');
    } finally {
      if (sourceHandle) await sourceHandle.close().catch(() => {});
      if (destinationHandle) await destinationHandle.close().catch(() => {});
      if (!renamed) await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
    return finalSourceIdentity;
  }

  async _removeVerifiedArtifactSource(scratchPath, expectedIdentity) {
    try {
      const current = await fsp.lstat(scratchPath, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
          || !sameArtifactSourceIdentity(fileIdentity(current), expectedIdentity)) return;
      await fsp.unlink(scratchPath);
      await this._syncDirectory(path.dirname(scratchPath));
    } catch {}
  }

  async _streamVerifiedPrivateFile(filePath, code) {
    let pathStat;
    let handle;
    try {
      pathStat = await fsp.lstat(filePath, { bigint: true });
      if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) {
        throw operationError(code);
      }
      const initialIdentity = fileIdentity(pathStat);
      handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n
          || !sameArtifactSourceIdentity(fileIdentity(opened), initialIdentity)) {
        throw operationError(code);
      }
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const stream = handle.createReadStream({ autoClose: false, start: 0 });
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES) {
          stream.destroy();
          throw operationError(code);
        }
        hash.update(chunk);
      }
      const openedAfter = await handle.stat({ bigint: true });
      const pathAfter = await fsp.lstat(filePath, { bigint: true });
      if (!openedAfter.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
          || openedAfter.nlink !== 1n || pathAfter.nlink !== 1n
          || !sameArtifactSourceIdentity(fileIdentity(openedAfter), initialIdentity)
          || !sameArtifactSourceIdentity(fileIdentity(pathAfter), initialIdentity)) {
        throw operationError(code);
      }
      return {
        identity: fileIdentity(pathAfter),
        bytes,
        sha256: hash.digest('hex'),
      };
    } catch (error) {
      if (error?.code === code) throw error;
      throw operationError(code, error);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async _verifyArtifactScratchSource(operationId, scratchPath, expectedBytes, expectedSha256) {
    if (typeof scratchPath !== 'string'
        || scratchPath.includes('\0')
        || !path.isAbsolute(scratchPath)
        || path.normalize(scratchPath) !== scratchPath) {
      throw operationError('result_artifact_invalid');
    }
    const scratchRoot = this._scratchPath(operationId);
    const relative = path.relative(scratchRoot, scratchPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw operationError('result_artifact_invalid');
    }
    const directoryPaths = [...this._operationAncestorPaths(operationId), scratchRoot];
    let cursor = scratchRoot;
    try {
      const components = relative.split(path.sep);
      for (let index = 0; index < components.length - 1; index += 1) {
        cursor = path.join(cursor, components[index]);
        const stat = await fsp.lstat(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw operationError('result_artifact_invalid');
        }
        directoryPaths.push(cursor);
      }
      return await this._withDirectoryConfinement(
        directoryPaths,
        'result_artifact_invalid',
        async () => {
          const verified = await this._streamVerifiedPrivateFile(
            scratchPath,
            'result_artifact_invalid',
          );
          if (verified.bytes !== expectedBytes || verified.sha256 !== expectedSha256) {
            throw operationError('result_artifact_invalid');
          }
          return verified.identity;
        },
      );
    } catch (error) {
      if (error?.code === 'result_artifact_invalid') throw error;
      throw operationError('result_artifact_invalid', error);
    }
  }

  async _inspectExactOrphanArtifact(operationId, input) {
    const artifactPath = this._resultArtifactPath(operationId);
    try {
      await fsp.lstat(artifactPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw operationError('result_conflict', error);
    }
    return this._withDirectoryConfinement(
      this._operationAncestorPaths(operationId),
      'result_conflict',
      async () => {
        const verified = await this._streamVerifiedPrivateFile(artifactPath, 'result_conflict');
        if (verified.bytes !== input.bytes || verified.sha256 !== input.sha256) {
          throw operationError('result_conflict');
        }
        return verified.identity;
      },
    );
  }

  async _removeOrphanHandleIndexes(operationId, requesterAgent) {
    await this._withHandleIndexLock(async () => {
      const entries = await fsp.readdir(this.resultHandlesRoot, { withFileTypes: true });
      let removed = false;
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const fixedMatch = entry.name.match(/^([a-f0-9]{64})\.json$/);
        const tempMatch = entry.name.match(/^\.([a-f0-9]{64})\.json\.tmp-\d+-[a-f0-9]+$/);
        const hash = fixedMatch?.[1] ?? tempMatch?.[1];
        if (!hash) continue;
        const entryPath = path.join(this.resultHandlesRoot, entry.name);
        if (tempMatch) {
          await fsp.rm(entryPath, { force: true });
          removed = true;
          continue;
        }
        let mapping;
        try {
          mapping = JSON.parse((await this._readSecureRegularFile(
            entryPath,
            undefined,
            'result_handle_invalid',
          )).toString('utf8'));
        } catch (error) {
          throw error;
        }
        if (mapping?.operationId !== operationId) continue;
        if (mapping.requesterAgent !== requesterAgent || mapping.handleSha256 !== hash) {
          throw operationError('result_handle_invalid');
        }
        await fsp.rm(entryPath, { force: true });
        removed = true;
      }
      if (removed) await this._syncDirectory(this.resultHandlesRoot);
    });
  }

  async _removeOperationPublicationTemps(operationId) {
    const operationRoot = this._operationDirectory(operationId);
    await this._withDirectoryConfinement(
      this._operationAncestorPaths(operationId),
      'operation_corrupt',
      async () => {
        let removed = false;
        for (const entry of await fsp.readdir(operationRoot, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          if (!/^\.(?:status\.json|result\.json|result\.artifact)\.tmp-\d+-[a-f0-9]+$/.test(entry.name)) continue;
          await fsp.rm(path.join(operationRoot, entry.name), { force: true });
          removed = true;
        }
        if (removed) await this._syncDirectory(operationRoot);
      },
    );
  }

  async adoptResultArtifact(operationId, input) {
    assertOperationId(operationId);
    exactInputKeys(input, [
      'expectedVersion', 'scratchPath', 'mediaType', 'contentEncoding', 'bytes', 'sha256',
    ], 'result_artifact_invalid');
    assertExpectedVersion(input.expectedVersion);
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0
        || input.bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES
        || input.mediaType !== 'application/x-ndjson'
        || input.contentEncoding !== 'identity'
        || typeof input.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(input.sha256)) {
      throw operationError('result_artifact_invalid');
    }
    return this._withOperationLock(operationId, async (record) => {
      this._assertMutable(record, input.expectedVersion);
      this._assertNoResult(record);
      await this._removeOperationPublicationTemps(operationId);
      await this._assertResultPathAbsent(this._resultJsonPath(operationId));
      const artifactPath = this._resultArtifactPath(operationId);
      let handle = null;
      let handleWritten = false;
      let sourceIdentity;
      const adoptionState = { artifactRenamed: false };
      try {
        const orphanIdentity = await this._inspectExactOrphanArtifact(operationId, input);
        if (orphanIdentity) {
          sourceIdentity = await this._verifyArtifactScratchSource(
            operationId,
            input.scratchPath,
            input.bytes,
            input.sha256,
          );
          if (orphanIdentity.dev === sourceIdentity.dev && orphanIdentity.ino === sourceIdentity.ino) {
            throw operationError('result_conflict');
          }
          await this._removeOrphanHandleIndexes(operationId, record.requesterAgent);
        } else {
          sourceIdentity = await this._copyArtifactIntoStore(
            operationId,
            input.scratchPath,
            input.bytes,
            input.sha256,
            adoptionState,
          );
        }
        handle = await this._allocateHandleIndex(operationId, record.requesterAgent);
        handleWritten = true;
        const metadata = {
          mediaType: input.mediaType,
          contentEncoding: input.contentEncoding,
          bytes: input.bytes,
          sha256: input.sha256,
        };
        const next = await this._commitMutation(record, (draft) => {
          draft.result = null;
          draft.resultHandle = handle;
          draft.resultArtifact = metadata;
          draft._resultKind = 'artifact';
        }, { type: 'result_ready', storage: 'artifact', ...metadata }, undefined,
        'after_artifact_status_rename');
        await this._removeVerifiedArtifactSource(input.scratchPath, sourceIdentity);
        return projectPublicRecord(next);
      } catch (error) {
        const published = await this._isPublishedResult(operationId, handle, 'artifact');
        if (published !== false) {
          throw this._durabilityUncertain(error);
        }
        if (handleWritten) await this._removeHandleIndex(handle).catch(() => {});
        if (adoptionState.artifactRenamed) {
          await this._withDirectoryConfinement(
            this._operationAncestorPaths(operationId),
            'result_corrupt',
            async () => {
              await fsp.rm(artifactPath, { force: true });
              await this._syncDirectory(this._operationDirectory(operationId));
            },
          ).catch(() => {});
        }
        throw error;
      }
    });
  }

  async openResultArtifact(operationId, input) {
    assertOperationId(operationId);
    exactInputKeys(input, ['requesterAgent', 'resultHandle'], 'result_handle_invalid');
    const record = await this._readPrivateRecord(operationId);
    if (record.resultExpiredAt !== null || record._resultKind === 'expired') {
      throw operationError('result_expired');
    }
    if (record._resultKind !== 'artifact') throw operationError('result_unavailable');
    await this._authorizeResult(record, input.requesterAgent, input.resultHandle);
    const artifactPath = this._resultArtifactPath(operationId);
    return this._withDirectoryConfinement(
      this._operationAncestorPaths(operationId),
      'result_corrupt',
      async () => {
        let stat;
        try {
          stat = await fsp.lstat(artifactPath, { bigint: true });
        } catch (error) {
          throw operationError('result_corrupt', error);
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
            || stat.size !== BigInt(record.resultArtifact.bytes)) {
          throw operationError('result_corrupt');
        }
        let handle;
        try {
          const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
          handle = await fsp.open(artifactPath, flags);
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || opened.nlink !== 1n
              || opened.dev !== stat.dev
              || opened.ino !== stat.ino
              || opened.size !== stat.size
              || opened.mtimeNs !== stat.mtimeNs
              || opened.ctimeNs !== stat.ctimeNs) {
            throw operationError('result_corrupt');
          }
          const stream = handle.createReadStream({ autoClose: true, start: 0 });
          handle = null;
          return {
            metadata: safeJsonClone(record.resultArtifact, 'operation_corrupt'),
            stream,
          };
        } catch (error) {
          if (error?.code === 'result_corrupt') throw error;
          throw operationError('result_corrupt', error);
        } finally {
          if (handle) await handle.close().catch(() => {});
        }
      },
    );
  }

  async openAttachment(operationId, attachmentId) {
    assertOperationId(operationId);
    assertIdentifier(attachmentId, 'attachmentId');
    return this._withOperationLock(operationId, async (record) => {
      if (TERMINAL_STATES.has(record.state)) throw operationError('operation_terminal');
      const attachmentPath = this._attachmentPath(operationId, attachmentId);
      try {
        const existing = await this._readAttachmentFile(operationId, attachmentId);
        if (existing.state === 'attached') return safeJsonClone(existing, 'attachment_corrupt');
        throw operationError('attachment_closed');
      } catch (error) {
        if (error.code !== 'attachment_not_found') throw error;
      }
      const now = isoTime(this._nowMs());
      const attachment = {
        attachmentId,
        operationId,
        requesterAgent: record.requesterAgent,
        state: 'attached',
        openedAt: now,
        updatedAt: now,
        detachedAt: null,
        closedAt: null,
        reason: null,
      };
      await this._ensureDirectory(path.dirname(attachmentPath), 'attachment_corrupt');
      await this._withDirectoryConfinement(
        [...this._operationAncestorPaths(operationId), path.dirname(attachmentPath)],
        'attachment_corrupt',
        () => this._writeJson(attachmentPath, attachment, 'before_attachment_rename'),
      );
      return safeJsonClone(attachment);
    });
  }

  async _readAttachmentFile(operationId, attachmentId) {
    const attachmentPath = this._attachmentPath(operationId, attachmentId);
    const attachmentDirectory = path.dirname(attachmentPath);
    try {
      await fsp.lstat(attachmentDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') throw operationError('attachment_not_found', error);
      throw operationError('attachment_corrupt', error);
    }
    return this._withDirectoryConfinement(
      [...this._operationAncestorPaths(operationId), attachmentDirectory],
      'attachment_corrupt',
      async () => {
        try {
          return JSON.parse((await this._readSecureRegularFile(
            attachmentPath,
            undefined,
            'attachment_corrupt',
            'attachment_not_found',
          )).toString('utf8'));
        } catch (error) {
          if (error.code === 'attachment_not_found') throw error;
          if (error.code === 'attachment_corrupt') throw error;
          throw operationError('attachment_corrupt', error);
        }
      },
    );
  }

  async getAttachment(operationId, attachmentId) {
    assertOperationId(operationId);
    assertIdentifier(attachmentId, 'attachmentId');
    await this._readPrivateRecord(operationId);
    const attachment = await this._readAttachmentFile(operationId, attachmentId);
    if (attachment.operationId !== operationId
        || attachment.attachmentId !== attachmentId
        || attachment.requesterAgent !== this.requesterAgent
        || !['attached', 'detached', 'closed'].includes(attachment.state)) {
      throw operationError('attachment_corrupt');
    }
    return safeJsonClone(attachment, 'attachment_corrupt');
  }

  async detachAttachment(operationId, attachmentId, reason) {
    assertOperationId(operationId);
    assertIdentifier(attachmentId, 'attachmentId');
    assertIdentifier(reason, 'attachmentReason');
    return this._withOperationLock(operationId, async () => {
      const current = await this.getAttachment(operationId, attachmentId);
      if (current.state === 'detached' && current.reason === reason) return current;
      if (current.state !== 'attached') throw operationError('attachment_closed');
      const now = isoTime(this._nowMs());
      const next = {
        ...current,
        state: 'detached',
        updatedAt: now,
        detachedAt: now,
        reason,
      };
      const attachmentPath = this._attachmentPath(operationId, attachmentId);
      await this._withDirectoryConfinement(
        [...this._operationAncestorPaths(operationId), path.dirname(attachmentPath)],
        'attachment_corrupt',
        () => this._writeJson(attachmentPath, next, 'before_attachment_rename'),
      );
      return safeJsonClone(next);
    });
  }

  async closeAttachment(operationId, attachmentId, reason) {
    assertOperationId(operationId);
    assertIdentifier(attachmentId, 'attachmentId');
    assertIdentifier(reason, 'attachmentReason');
    return this._withOperationLock(operationId, async () => {
      const current = await this.getAttachment(operationId, attachmentId);
      if (current.state === 'closed') {
        if (current.reason === reason) return current;
        throw operationError('attachment_closed');
      }
      if (current.state !== 'attached' && current.state !== 'detached') {
        throw operationError('attachment_closed');
      }
      const now = isoTime(this._nowMs());
      const next = {
        ...current,
        state: 'closed',
        updatedAt: now,
        closedAt: now,
        reason,
      };
      const attachmentPath = this._attachmentPath(operationId, attachmentId);
      await this._withDirectoryConfinement(
        [...this._operationAncestorPaths(operationId), path.dirname(attachmentPath)],
        'attachment_corrupt',
        () => this._writeJson(attachmentPath, next, 'before_attachment_rename'),
      );
      return safeJsonClone(next);
    });
  }

  async releaseSourcePinOnce(operationId, releasedAt, release) {
    assertOperationId(operationId);
    const releasedMilliseconds = typeof releasedAt === 'string'
      ? Date.parse(releasedAt)
      : Number.NaN;
    if (!Number.isFinite(releasedMilliseconds)
        || new Date(releasedMilliseconds).toISOString() !== releasedAt) {
      throw operationError('source_pin_release_invalid');
    }
    if (typeof release !== 'function') throw operationError('source_pin_release_invalid');
    return this._withOperationLock(operationId, async (record) => {
      if (record.sourcePinReleasedAt !== null) return projectPublicRecord(record);
      if (record.sourcePinDescriptor === null) return projectPublicRecord(record);
      if (!TERMINAL_STATES.has(record.state)) throw operationError('operation_nonterminal');
      await release(record.operationId, safeJsonClone(record.sourcePinDescriptor));
      const next = safeJsonClone(record, 'operation_corrupt');
      next.sourcePinReleasedAt = releasedAt;
      next.recordVersion = record.recordVersion + 1;
      next.updatedAt = isoTime(this._nowMs());
      await this._writeJson(this._statusPath(operationId), next, 'before_source_pin_release_status_rename');
      return projectPublicRecord(next);
    });
  }

  async _expireResult(operationId, now) {
    return this._withOperationLock(operationId, async (record) => {
      if (!TERMINAL_STATES.has(record.state)) return false;

      let marked = record;
      if (record._resultCleanup === null) {
        if (record.resultExpiredAt !== null
            || !record.resultExpiresAt
            || Date.parse(record.resultExpiresAt) > now) return false;
        const markedAt = isoTime(now);
        marked = safeJsonClone(record, 'operation_corrupt');
        marked._resultCleanup = {
          handle: record.resultHandle,
          kind: record._resultKind,
          markedAt,
        };
        marked.result = null;
        marked.resultHandle = null;
        marked.resultExpiredAt = markedAt;
        marked._resultKind = 'expired';
        marked.recordVersion = record.recordVersion + 1;
        marked.updatedAt = markedAt;
        await this._writeJson(
          this._statusPath(operationId),
          marked,
          'before_gc_result_marker_rename',
        );
        await this._inject('after_gc_result_marker', { operationId });
      }

      await fsp.rm(this._resultJsonPath(operationId), { force: true });
      await fsp.rm(this._resultArtifactPath(operationId), { force: true });
      await this._removeHandleIndex(marked._resultCleanup.handle);
      await fsp.rm(this._scratchPath(operationId), { recursive: true, force: true });
      await this._syncDirectory(this._operationDirectory(operationId));
      await this._inject('after_gc_result_delete', { operationId });

      const cleaned = safeJsonClone(marked, 'operation_corrupt');
      cleaned._resultCleanup = null;
      cleaned.recordVersion = marked.recordVersion + 1;
      cleaned.updatedAt = isoTime(now);
      await this._writeJson(
        this._statusPath(operationId),
        cleaned,
        'before_gc_result_cleanup_clear_rename',
      );
      return true;
    });
  }

  async _deleteExpiredMetadata(operationId, now) {
    return this._withIdempotencyLock(async () => {
      let recordForDelete = null;
      await this._withOperationLock(operationId, async (record) => {
        if (!TERMINAL_STATES.has(record.state)
            || !record.metadataExpiresAt
            || Date.parse(record.metadataExpiresAt) > now
            || (record.sourcePinDescriptor !== null && record.sourcePinReleasedAt === null)) return;
        if (record._deleting) {
          recordForDelete = record;
          return;
        }
        const deleting = safeJsonClone(record, 'operation_corrupt');
        deleting._deleting = true;
        deleting.recordVersion = record.recordVersion + 1;
        deleting.updatedAt = isoTime(now);
        await this._writeJson(this._statusPath(operationId), deleting, 'before_gc_delete_marker_rename');
        recordForDelete = deleting;
      }, { allowDeleting: true });
      if (!recordForDelete) return false;

      let { index, syntaxCorrupt } = await this._readIndex();
      if (syntaxCorrupt) {
        const claims = await this._scanClaims();
        const claim = claims.get(recordForDelete._idempotencyKey);
        if (!claim || claim.operationId === operationId) claims.delete(recordForDelete._idempotencyKey);
        index = await this._rebuildIndexFromClaims(claims, 'before_gc_index_rename');
      } else {
        const entry = index.entries[recordForDelete._idempotencyKey];
        if (!entry || entry.operationId === operationId) {
          delete index.entries[recordForDelete._idempotencyKey];
          await this._writeJson(this.idempotencyIndexPath, index, 'before_gc_index_rename');
        }
      }
      await this._inject('before_gc_operation_rm', { operationId });
      await fsp.rm(this._operationDirectory(operationId), { recursive: true, force: true });
      await this._syncDirectory(this.operationsRoot);
      this.eventCache.delete(operationId);
      return true;
    });
  }

  async collectGarbage(explicitNow) {
    const now = this._nowMs(explicitNow);
    const receipt = { resultsExpired: 0, metadataDeleted: 0 };
    const operationIds = await this._listOperationIds();
    for (const operationId of operationIds) {
      let record;
      try {
        record = await this._readPrivateRecord(operationId);
      } catch (error) {
        if (error.code === 'operation_not_found') continue;
        throw error;
      }
      if (!TERMINAL_STATES.has(record.state)) continue;
      if (record._deleting) {
        if (await this._deleteExpiredMetadata(operationId, now)) receipt.metadataDeleted += 1;
        continue;
      }
      if (await this._expireResult(operationId, now)) receipt.resultsExpired += 1;
      record = await this._readPrivateRecord(operationId).catch((error) => {
        if (error.code === 'operation_not_found') return null;
        throw error;
      });
      if (record && record.metadataExpiresAt && Date.parse(record.metadataExpiresAt) <= now) {
        if (await this._deleteExpiredMetadata(operationId, now)) receipt.metadataDeleted += 1;
      }
    }
    return receipt;
  }
}

module.exports = {
  BrainOperationStore,
  METADATA_RETENTION_MS,
  RESULT_RETENTION_MS,
};
