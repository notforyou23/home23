'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { memorySourceError, throwIfAborted } = require('./contracts.cjs');

const LEDGER_NAME = '.scratch-quota.json';
const LOCK_NAME = '.scratch-quota.lock';
const MAX_LEDGER_BYTES = 256 * 1024;
const MAX_LOCK_BYTES = 2 * 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const RECONCILE_CLAIM_BYTES = 64 * 1024 * 1024;
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);
const execFileAsync = promisify(execFile);
const FALLBACK_PROCESS_TOKEN = `unverifiable:${process.pid}:${PROCESS_STARTED_AT}:${randomUUID()}`;
const LOCK_TURNOVER = Symbol('scratch-lock-turnover');

function quotaExceeded(message) {
  return memorySourceError('result_too_large', message, {
    status: 413,
    retryable: false,
  });
}

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw memorySourceError('invalid_request', 'invalid scratch quota');
  }
  return maxBytes;
}

function validateKind(kind) {
  if (typeof kind !== 'string' || kind.length < 1
      || Buffer.byteLength(kind, 'utf8') > 128 || kind.includes('\0')) {
    throw memorySourceError('invalid_request', 'invalid scratch claim kind');
  }
  return kind;
}

function validateBytes(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw memorySourceError('invalid_request', `invalid scratch ${label}`);
  }
  return bytes;
}

async function assertOperationRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')
      || Buffer.byteLength(root, 'utf8') > 4096) {
    throw memorySourceError('invalid_request', 'trusted operation root required');
  }
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw memorySourceError('invalid_memory_source', 'operation root is not a directory', {
      retryable: false,
    });
  }
  return fsp.realpath(root);
}

function boundedIdentityToken(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 512;
}

function validateProcessOwner(owner, expectedHandleId) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isSafeInteger(owner.processStartedAt) || owner.processStartedAt < 0
      || !/^[a-f0-9-]{36}$/.test(owner.handleId || '')
      || (expectedHandleId !== undefined && owner.handleId !== expectedHandleId)
      || !boundedIdentityToken(owner.bootToken)
      || !boundedIdentityToken(owner.processStartToken)) {
    throw memorySourceError('invalid_memory_source', 'invalid scratch process identity', {
      retryable: false,
    });
  }
  return owner;
}

async function readDarwinProcessIdentity(pid) {
  let bootToken;
  try {
    ({ stdout: bootToken } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }));
  } catch {
    return null;
  }
  let processOutput;
  try {
    ({ stdout: processOutput } = await execFileAsync('/bin/ps', [
      '-p', String(pid), '-o', 'pid=,lstart=',
    ], {
      encoding: 'utf8',
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }));
  } catch (error) {
    if (error.code === 1) return false;
    return null;
  }
  const normalized = processOutput.trim().replace(/\s+/g, ' ');
  if (!normalized.startsWith(`${pid} `)) return null;
  return {
    bootToken: bootToken.trim(),
    processStartToken: normalized.slice(String(pid).length + 1),
  };
}

async function readLinuxProcessIdentity(pid) {
  let bootToken;
  let statText;
  try {
    [bootToken, statText] = await Promise.all([
      fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    return null;
  }
  const closeParen = statText.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/);
  const processStartToken = fields[19];
  if (!processStartToken) return null;
  return { bootToken: bootToken.trim(), processStartToken };
}

async function inspectProcessIdentity(pid) {
  if (process.platform === 'darwin') return readDarwinProcessIdentity(pid);
  if (process.platform === 'linux') return readLinuxProcessIdentity(pid);
  return null;
}

let currentExactIdentityPromise = null;
function inspectCurrentProcessIdentity() {
  currentExactIdentityPromise ||= inspectProcessIdentity(process.pid);
  return currentExactIdentityPromise;
}

async function currentProcessIdentity(handleId) {
  const exact = await inspectCurrentProcessIdentity();
  return Object.freeze({
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    handleId,
    bootToken: exact && exact !== false ? exact.bootToken : `unverifiable-boot:${FALLBACK_PROCESS_TOKEN}`,
    processStartToken: exact && exact !== false
      ? exact.processStartToken
      : `unverifiable-start:${FALLBACK_PROCESS_TOKEN}`,
  });
}

async function defaultIsProcessAlive(owner) {
  validateProcessOwner(owner);
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return null;
  }
  const exact = owner.pid === process.pid
    ? await inspectCurrentProcessIdentity()
    : await inspectProcessIdentity(owner.pid);
  if (exact === false) return false;
  if (exact === null) return null;
  return exact.bootToken === owner.bootToken
    && exact.processStartToken === owner.processStartToken;
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason || Object.assign(new Error('cancelled'), {
        name: 'AbortError',
        code: 'cancelled',
      }));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(stat, identity) {
  return stat !== null && stat !== undefined
    && stat.dev === identity.dev && stat.ino === identity.ino;
}

async function lstatOptional(filePath) {
  return fsp.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function readBoundedRegularFile(filePath, maxBytes, {
  optional = false,
  turnoverIsRetryable = false,
  assertParent,
} = {}) {
  await assertParent?.();
  let before;
  try {
    before = await fsp.lstat(filePath);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw memorySourceError('invalid_memory_source', 'scratch metadata is not a regular file', {
      retryable: false,
    });
  }
  if (before.size > maxBytes) {
    throw quotaExceeded('scratch metadata limit exceeded');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(filePath, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > maxBytes) {
      if (turnoverIsRetryable && opened.isFile()) {
        const turnover = new Error('scratch lock turned over during open');
        turnover[LOCK_TURNOVER] = true;
        throw turnover;
      }
      throw memorySourceError('invalid_memory_source', 'scratch metadata changed during open', {
        retryable: false,
      });
    }
    const result = {
      text: await handle.readFile('utf8'),
      size: opened.size,
      dev: opened.dev,
      ino: opened.ino,
    };
    await assertParent?.();
    const after = await fsp.lstat(filePath).catch((error) => {
      if (turnoverIsRetryable && error.code === 'ENOENT') return null;
      throw error;
    });
    if (after === null || after.dev !== opened.dev || after.ino !== opened.ino
        || after.isSymbolicLink() || !after.isFile()) {
      if (turnoverIsRetryable && (after === null || after?.isFile())) {
        const turnover = new Error('scratch lock turned over during read');
        turnover[LOCK_TURNOVER] = true;
        throw turnover;
      }
      throw memorySourceError('invalid_memory_source', 'scratch metadata changed during read', {
        retryable: false,
      });
    }
    return result;
  } finally {
    await handle?.close();
  }
}

function normalizeReservations(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw memorySourceError('invalid_memory_source', 'invalid scratch reservation ledger');
  }
  const result = {};
  for (const [handleId, reservation] of Object.entries(value)) {
    if (!/^[a-f0-9-]{36}$/.test(handleId) || !reservation || typeof reservation !== 'object') {
      throw memorySourceError('invalid_memory_source', 'invalid scratch reservation owner');
    }
    const owner = validateProcessOwner(reservation.owner, handleId);
    if (!reservation.kinds || typeof reservation.kinds !== 'object'
        || Array.isArray(reservation.kinds)) {
      throw memorySourceError('invalid_memory_source', 'invalid scratch reservation kinds');
    }
    const kinds = {};
    for (const [kind, bytes] of Object.entries(reservation.kinds)) {
      validateKind(kind);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw memorySourceError('invalid_memory_source', 'invalid scratch reservation bytes');
      }
      kinds[kind] = bytes;
    }
    result[handleId] = { owner: { ...owner }, kinds };
  }
  return result;
}

function reservationTotal(reservations) {
  let total = 0;
  for (const reservation of Object.values(reservations)) {
    for (const bytes of Object.values(reservation.kinds)) {
      total += bytes;
      if (!Number.isSafeInteger(total)) throw quotaExceeded('scratch reservation total overflow');
    }
  }
  return total;
}

function checkedTotal(values, message) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) throw quotaExceeded(message);
  }
  return total;
}

function serializeLedger(input) {
  let usedBytes = 0;
  let text = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ledger = {
      version: 1,
      operationRoot: input.operationRoot,
      maxBytes: input.maxBytes,
      actualPrivateBytes: input.actualPrivateBytes,
      claimedSinceReconcile: input.claimedSinceReconcile,
      reservations: input.reservations,
      usedBytes,
      updatedAt: input.updatedAt,
    };
    text = `${JSON.stringify(ledger)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_LEDGER_BYTES) {
      throw quotaExceeded('scratch quota ledger limit exceeded');
    }
    const next = checkedTotal([
      reservationTotal(input.reservations),
      input.actualPrivateBytes,
      Buffer.byteLength(text, 'utf8'),
      MAX_LOCK_BYTES,
    ], 'scratch accounting total overflow');
    if (next === usedBytes) return { text, usedBytes };
    usedBytes = next;
  }
  const ledger = {
    version: 1,
    operationRoot: input.operationRoot,
    maxBytes: input.maxBytes,
    actualPrivateBytes: input.actualPrivateBytes,
    claimedSinceReconcile: input.claimedSinceReconcile,
    reservations: input.reservations,
    usedBytes,
    updatedAt: input.updatedAt,
  };
  text = `${JSON.stringify(ledger)}\n`;
  return { text, usedBytes };
}

function parseLedger(text, { operationRoot, maxBytes }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw memorySourceError('invalid_memory_source', 'scratch quota ledger is malformed', {
      retryable: false,
      cause: error,
    });
  }
  if (parsed?.version !== 1 || parsed.operationRoot !== operationRoot
      || !Number.isSafeInteger(parsed.maxBytes) || parsed.maxBytes <= 0
      || !Number.isSafeInteger(parsed.actualPrivateBytes) || parsed.actualPrivateBytes < 0
      || !Number.isSafeInteger(parsed.claimedSinceReconcile ?? 0)
      || (parsed.claimedSinceReconcile ?? 0) < 0
      || !Number.isSafeInteger(parsed.usedBytes) || parsed.usedBytes < 0) {
    throw memorySourceError('invalid_memory_source', 'scratch quota ledger identity is invalid', {
      retryable: false,
    });
  }
  if (parsed.maxBytes !== maxBytes) {
    throw memorySourceError('invalid_request', 'scratch quota maximum does not match durable ledger', {
      retryable: false,
    });
  }
  const reservations = normalizeReservations(parsed.reservations);
  const minimumUsedBytes = checkedTotal([
    parsed.actualPrivateBytes,
    reservationTotal(reservations),
    Buffer.byteLength(text, 'utf8'),
    MAX_LOCK_BYTES,
  ], 'scratch accounting total overflow');
  if (parsed.usedBytes < minimumUsedBytes) {
    throw memorySourceError('invalid_memory_source', 'scratch quota ledger undercounts usage', {
      retryable: false,
    });
  }
  return {
    operationRoot,
    maxBytes,
    actualPrivateBytes: parsed.actualPrivateBytes,
    claimedSinceReconcile: parsed.claimedSinceReconcile ?? 0,
    reservations,
    usedBytes: parsed.usedBytes,
  };
}

async function scanPrivateBytes(operationRoot, {
  signal,
  rootIdentity,
  assertStableOperationRoot,
  hooks,
} = {}) {
  let total = 0;
  async function walk(directory, directoryIdentity, isRoot = false) {
    throwIfAborted(signal);
    await assertStableOperationRoot?.();
    const before = await fsp.lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()
        || !sameIdentity(before, directoryIdentity)) {
      throw memorySourceError('invalid_memory_source', 'scratch directory identity changed', {
        retryable: false,
      });
    }
    const entries = await fsp.readdir(directory);
    entries.sort((left, right) => left.localeCompare(right));
    await hooks?.afterScanDirectoryRead?.(directory);
    await assertStableOperationRoot?.();
    const afterRead = await fsp.lstat(directory);
    if (afterRead.isSymbolicLink() || !afterRead.isDirectory()
        || !sameIdentity(afterRead, directoryIdentity)) {
      throw memorySourceError('invalid_memory_source', 'scratch directory changed during scan', {
        retryable: false,
      });
    }
    for (const name of entries) {
      throwIfAborted(signal);
      if (isRoot && (name === LEDGER_NAME || name === LOCK_NAME)) continue;
      const filePath = path.join(directory, name);
      const stat = await fsp.lstat(filePath).catch((error) => {
        // A losing lock candidate is unlinked immediately after the atomic
        // link attempt. Its disappearance during this snapshot is benign; a
        // surviving candidate is counted below like every other private file.
        if (error.code === 'ENOENT' && isRoot && name.startsWith(`${LOCK_NAME}.candidate-`)) {
          return null;
        }
        throw error;
      });
      if (stat === null) continue;
      if (stat.isSymbolicLink()) {
        throw memorySourceError('invalid_memory_source', 'operation scratch contains a symbolic link', {
          retryable: false,
        });
      }
      if (stat.isDirectory()) {
        await walk(filePath, identityOf(stat), false);
      } else if (stat.isFile()) {
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
        let handle;
        let vanishedLockCandidate = false;
        try {
          handle = await fsp.open(filePath, flags).catch((error) => {
            if (error.code === 'ENOENT' && isRoot
                && name.startsWith(`${LOCK_NAME}.candidate-`)) {
              vanishedLockCandidate = true;
              return null;
            }
            throw error;
          });
          if (vanishedLockCandidate) continue;
          const opened = await handle.stat();
          if (!opened.isFile() || !sameIdentity(opened, identityOf(stat))) {
            throw memorySourceError('invalid_memory_source', 'scratch file changed during scan', {
              retryable: false,
            });
          }
          total += opened.size;
        } finally {
          await handle?.close().catch(() => {});
        }
        if (!Number.isSafeInteger(total)) throw quotaExceeded('scratch file total overflow');
      } else {
        throw memorySourceError('invalid_memory_source', 'operation scratch contains a special file', {
          retryable: false,
        });
      }
      await assertStableOperationRoot?.();
    }
    const after = await fsp.lstat(directory);
    if (after.isSymbolicLink() || !after.isDirectory()
        || !sameIdentity(after, directoryIdentity)) {
      throw memorySourceError('invalid_memory_source', 'scratch directory changed after scan', {
        retryable: false,
      });
    }
  }
  await walk(operationRoot, rootIdentity, true);
  await assertStableOperationRoot?.();
  return total;
}

async function createOperationScratchQuota({
  operationRoot,
  maxBytes = DEFAULT_MAX_BYTES,
  signal,
  lockRetryMs = 5,
  lockTimeoutMs = 30_000,
  isProcessAlive = defaultIsProcessAlive,
  clock = Date,
  _testHooks = {},
} = {}) {
  const root = await assertOperationRoot(operationRoot);
  validateMaxBytes(maxBytes);
  if (typeof isProcessAlive !== 'function' || typeof clock?.now !== 'function') {
    throw memorySourceError('invalid_request', 'invalid scratch quota coordination hooks');
  }
  if (!_testHooks || typeof _testHooks !== 'object' || Array.isArray(_testHooks)
      || Object.values(_testHooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid scratch quota test hooks');
  }
  const hooks = _testHooks;
  const handleId = randomUUID();
  const owner = await currentProcessIdentity(handleId);
  const initialRootStat = await fsp.lstat(root);
  const rootIdentity = Object.freeze({ dev: initialRootStat.dev, ino: initialRootStat.ino });
  const ledgerPath = path.join(root, LEDGER_NAME);
  const lockPath = path.join(root, LOCK_NAME);
  let closed = false;
  let localUsedBytes = 0;

  function assertOpen() {
    if (closed) throw memorySourceError('invalid_request', 'scratch quota is closed');
    throwIfAborted(signal);
  }

  async function assertStableOperationRoot() {
    const stat = await fsp.lstat(root).catch((error) => {
      throw memorySourceError('invalid_memory_source', 'operation root became unavailable', {
        retryable: false,
        cause: error,
      });
    });
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || stat.dev !== rootIdentity.dev || stat.ino !== rootIdentity.ino) {
      throw memorySourceError('invalid_memory_source', 'operation root identity changed', {
        retryable: false,
      });
    }
  }

  async function removeExactOwnedPath(filePath, identity) {
    if (!identity) return false;
    await assertStableOperationRoot();
    const stat = await lstatOptional(filePath);
    if (stat === null) return true;
    if (stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(stat, identity)) {
      return false;
    }
    await fsp.unlink(filePath);
    await assertStableOperationRoot();
    return true;
  }

  async function writeLedgerAtomic(text) {
    const tmpPath = path.join(root, `${LEDGER_NAME}.tmp-${process.pid}-${randomUUID()}`);
    let handle;
    let candidateIdentity = null;
    let published = false;
    try {
      await assertStableOperationRoot();
      handle = await fsp.open(
        tmpPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw memorySourceError('invalid_memory_source', 'scratch ledger candidate is not regular', {
          retryable: false,
        });
      }
      candidateIdentity = identityOf(opened);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await hooks.beforeLedgerPublish?.({ operationRoot: root, candidatePath: tmpPath });
      await assertStableOperationRoot();
      const candidate = await fsp.lstat(tmpPath);
      if (candidate.isSymbolicLink() || !candidate.isFile()
          || !sameIdentity(candidate, candidateIdentity)) {
        throw memorySourceError('invalid_memory_source', 'scratch ledger candidate changed', {
          retryable: false,
        });
      }
      await fsp.rename(tmpPath, ledgerPath);
      published = true;
      await assertStableOperationRoot();
      const publishedStat = await fsp.lstat(ledgerPath);
      if (publishedStat.isSymbolicLink() || !publishedStat.isFile()
          || !sameIdentity(publishedStat, candidateIdentity)) {
        throw memorySourceError('invalid_memory_source', 'scratch ledger publish identity changed', {
          retryable: false,
        });
      }
      await hooks.afterLedgerPublish?.({ operationRoot: root, ledgerPath });
      await assertStableOperationRoot();
      await fsyncDirectory(root);
      await assertStableOperationRoot();
    } finally {
      await handle?.close().catch(() => {});
      if (!published) {
        await removeExactOwnedPath(tmpPath, candidateIdentity).catch(() => {});
      }
    }
  }

  async function acquireLock() {
    const startedAt = clock.now();
    const record = `${JSON.stringify({
      version: 1,
      operationRoot: root,
      maxBytes,
      owner,
      acquiredAt: startedAt,
    })}\n`;
    if (Buffer.byteLength(record, 'utf8') > MAX_LOCK_BYTES) {
      throw memorySourceError('invalid_request', 'scratch lock record is too large');
    }
    for (;;) {
      assertOpen();
      await assertStableOperationRoot();
      const candidatePath = path.join(root, `${LOCK_NAME}.candidate-${process.pid}-${randomUUID()}`);
      let candidateHandle;
      let candidateIdentity = null;
      try {
        candidateHandle = await fsp.open(
          candidatePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        const opened = await candidateHandle.stat();
        if (!opened.isFile()) {
          throw memorySourceError('invalid_memory_source', 'scratch lock candidate is not regular', {
            retryable: false,
          });
        }
        candidateIdentity = identityOf(opened);
        await candidateHandle.writeFile(record, 'utf8');
        await candidateHandle.sync();
        await candidateHandle.close();
        candidateHandle = null;
        await hooks.afterLockCandidateSynced?.({ operationRoot: root, candidatePath });
        await assertStableOperationRoot();
        const candidate = await fsp.lstat(candidatePath);
        if (candidate.isSymbolicLink() || !candidate.isFile()
            || !sameIdentity(candidate, candidateIdentity)) {
          throw memorySourceError('invalid_memory_source', 'scratch lock candidate changed', {
            retryable: false,
          });
        }
        // Publishing a hard link is an atomic no-replace lock acquisition. A
        // contender therefore sees either no lock or the complete fsynced
        // owner record, never the zero-byte window created by open('wx').
        await fsp.link(candidatePath, lockPath);
        await assertStableOperationRoot();
        const publishedLock = await fsp.lstat(lockPath);
        if (publishedLock.isSymbolicLink() || !publishedLock.isFile()
            || !sameIdentity(publishedLock, candidateIdentity)) {
          throw memorySourceError('invalid_memory_source', 'scratch lock publish identity changed', {
            retryable: false,
          });
        }
        if (!await removeExactOwnedPath(candidatePath, candidateIdentity)) {
          throw memorySourceError('invalid_memory_source', 'scratch lock candidate cleanup changed', {
            retryable: false,
          });
        }
        await fsyncDirectory(root);
        await assertStableOperationRoot();
        return async () => {
          await assertStableOperationRoot();
          const stat = await fsp.lstat(lockPath).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (stat === null || stat.isSymbolicLink() || !stat.isFile()
              || !sameIdentity(stat, candidateIdentity)) {
            throw memorySourceError('invalid_memory_source', 'scratch lock ownership changed', {
              retryable: false,
            });
          }
          await fsp.unlink(lockPath);
          await assertStableOperationRoot();
          await fsyncDirectory(root);
          await assertStableOperationRoot();
        };
      } catch (error) {
        await candidateHandle?.close().catch(() => {});
        await removeExactOwnedPath(candidatePath, candidateIdentity).catch(() => {});
        if (error.code !== 'EEXIST') throw error;
        const current = await readBoundedRegularFile(lockPath, MAX_LOCK_BYTES, {
          turnoverIsRetryable: true,
          assertParent: assertStableOperationRoot,
        }).catch((readError) => {
          if (readError.code === 'ENOENT' || readError[LOCK_TURNOVER]) return null;
          throw readError;
        });
        if (current === null) continue;
        let lockRecord;
        try {
          lockRecord = JSON.parse(current.text);
        } catch (parseError) {
          throw memorySourceError('invalid_memory_source', 'scratch lock is malformed', {
            retryable: false,
            cause: parseError,
          });
        }
        if (lockRecord?.version !== 1 || lockRecord.operationRoot !== root
            || lockRecord.maxBytes !== maxBytes
            || !Number.isSafeInteger(lockRecord.acquiredAt) || lockRecord.acquiredAt < 0) {
          throw memorySourceError('invalid_memory_source', 'scratch lock identity mismatch', {
            retryable: false,
          });
        }
        validateProcessOwner(lockRecord.owner);
        let ownerAlive = null;
        try {
          const inspected = await isProcessAlive(lockRecord.owner);
          if (inspected === true || inspected === false) ownerAlive = inspected;
        } catch {
          ownerAlive = null;
        }
        if (ownerAlive === false) {
          await assertStableOperationRoot();
          const latest = await fsp.lstat(lockPath).catch((statError) => {
            if (statError.code === 'ENOENT') return null;
            throw statError;
          });
          if (latest === null) continue;
          if (latest.isSymbolicLink() || !latest.isFile()) {
            throw memorySourceError('invalid_memory_source', 'scratch lock changed type', {
              retryable: false,
            });
          }
          // The old owner was proven dead, but it is still possible that a
          // different contender replaced the path after our read. Remove only
          // the exact inode whose owner record was inspected.
          if (latest.dev !== current.dev || latest.ino !== current.ino) continue;
          await fsp.unlink(lockPath);
          await assertStableOperationRoot();
          await fsyncDirectory(root);
          await assertStableOperationRoot();
          continue;
        }
        if (clock.now() - startedAt >= lockTimeoutMs) {
          throw memorySourceError('source_busy', 'scratch quota lock is busy', { retryable: true });
        }
        await abortableDelay(lockRetryMs, signal);
      }
    }
  }

  async function readLedger() {
    const file = await readBoundedRegularFile(ledgerPath, MAX_LEDGER_BYTES, {
      optional: true,
      assertParent: assertStableOperationRoot,
    });
    if (file === null) {
      return {
        operationRoot: root,
        maxBytes,
        actualPrivateBytes: 0,
        claimedSinceReconcile: 0,
        reservations: {},
        usedBytes: 0,
        ledgerBytes: 0,
      };
    }
    return { ...parseLedger(file.text, { operationRoot: root, maxBytes }), ledgerBytes: file.size };
  }

  async function transact(mutator, { reconcile = false } = {}) {
    assertOpen();
    const releaseLock = await acquireLock();
    try {
      assertOpen();
      const prior = await readLedger();
      const next = await mutator({
        ...prior,
        reservations: structuredClone(prior.reservations),
      });
      if (reconcile || next.claimedSinceReconcile >= RECONCILE_CLAIM_BYTES) {
        next.actualPrivateBytes = await scanPrivateBytes(root, {
          signal,
          rootIdentity,
          assertStableOperationRoot,
          hooks,
        });
        for (const [reservationHandleId, reservation] of Object.entries(next.reservations)) {
          let alive = null;
          try {
            const inspected = await isProcessAlive(reservation.owner);
            if (inspected === true || inspected === false) alive = inspected;
          } catch {
            // Failure to prove death is not authority to reclaim accounting.
            // This also stays conservative for a reused PID whose start
            // identity cannot be inspected by the platform.
            alive = null;
          }
          if (alive === false) delete next.reservations[reservationHandleId];
        }
        next.claimedSinceReconcile = 0;
      }
      const serialized = serializeLedger({
        operationRoot: root,
        maxBytes,
        actualPrivateBytes: next.actualPrivateBytes,
        claimedSinceReconcile: next.claimedSinceReconcile,
        reservations: next.reservations,
        updatedAt: clock.now(),
      });
      const ledgerBytes = Buffer.byteLength(serialized.text, 'utf8');
      // During atomic replacement the old ledger still authorizes its
      // reservations while the new physical scan and candidate ledger both
      // exist. The two reservation totals are alternate metadata versions of
      // the same claims, so their maximum overlaps exactly; neither may
      // overlap with physical private bytes.
      const maintenancePeak = checkedTotal([
        next.actualPrivateBytes,
        Math.max(
          reservationTotal(prior.reservations),
          reservationTotal(next.reservations),
        ),
        prior.ledgerBytes,
        ledgerBytes,
        MAX_LOCK_BYTES,
      ], 'scratch maintenance accounting overflow');
      if (serialized.usedBytes > maxBytes || maintenancePeak > maxBytes) {
        throw quotaExceeded('aggregate operation scratch quota exceeded');
      }
      await writeLedgerAtomic(serialized.text);
      localUsedBytes = serialized.usedBytes;
      return localUsedBytes;
    } finally {
      await releaseLock();
    }
  }

  await transact(async (ledger) => ledger, { reconcile: true });

  const api = {
    operationRoot: root,
    maxBytes,
    async assertOperationRoot(candidate) {
      assertOpen();
      await assertStableOperationRoot();
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
        throw memorySourceError('invalid_request', 'exact operation root required');
      }
      const canonical = await fsp.realpath(candidate).catch(() => null);
      if (canonical !== root) {
        throw memorySourceError('invalid_request', 'scratch quota operation root mismatch');
      }
      const stat = await fsp.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw memorySourceError('invalid_memory_source', 'operation root is not a directory');
      }
      if (!sameIdentity(stat, rootIdentity)) {
        throw memorySourceError('invalid_memory_source', 'operation root identity changed', {
          retryable: false,
        });
      }
      return true;
    },
    async claim(bytes, kind = 'scratch') {
      assertOpen();
      validateBytes(bytes, 'claim');
      validateKind(kind);
      return transact(async (ledger) => {
        if (bytes === 0) return ledger;
        const reservation = ledger.reservations[handleId] || { owner: { ...owner }, kinds: {} };
        const prior = reservation.kinds[kind] || 0;
        const next = prior + bytes;
        if (!Number.isSafeInteger(next)) throw quotaExceeded('scratch claim overflow');
        const sinceReconcile = ledger.claimedSinceReconcile + bytes;
        if (!Number.isSafeInteger(sinceReconcile)) throw quotaExceeded('scratch claim counter overflow');
        reservation.kinds[kind] = next;
        ledger.reservations[handleId] = reservation;
        ledger.claimedSinceReconcile = sinceReconcile;
        return ledger;
      }, { reconcile: true });
    },
    async release(bytes, kind) {
      assertOpen();
      validateBytes(bytes, 'release');
      if (kind !== undefined) validateKind(kind);
      return transact(async (ledger) => {
        if (bytes === 0) return ledger;
        const reservation = ledger.reservations[handleId];
        const owned = reservation
          ? Object.values(reservation.kinds).reduce((sum, value) => sum + value, 0)
          : 0;
        if (bytes > owned) {
          throw memorySourceError('invalid_request', 'scratch release exceeds handle accounting');
        }
        if (kind !== undefined) {
          const prior = reservation.kinds[kind] || 0;
          if (bytes > prior) {
            throw memorySourceError('invalid_request', 'scratch release exceeds kind accounting');
          }
          if (bytes === prior) delete reservation.kinds[kind];
          else reservation.kinds[kind] = prior - bytes;
        } else {
          let remaining = bytes;
          for (const key of Object.keys(reservation.kinds).sort()) {
            const amount = Math.min(remaining, reservation.kinds[key]);
            reservation.kinds[key] -= amount;
            remaining -= amount;
            if (reservation.kinds[key] === 0) delete reservation.kinds[key];
            if (remaining === 0) break;
          }
        }
        if (Object.keys(reservation.kinds).length === 0) delete ledger.reservations[handleId];
        return ledger;
      }, { reconcile: true });
    },
    async reconcile() {
      assertOpen();
      return transact(async (ledger) => ledger, { reconcile: true });
    },
    get usedBytes() { return localUsedBytes; },
    close() { closed = true; },
  };
  return Object.freeze(api);
}

module.exports = {
  LEDGER_NAME,
  LOCK_NAME,
  assertOperationRoot,
  createOperationScratchQuota,
};
