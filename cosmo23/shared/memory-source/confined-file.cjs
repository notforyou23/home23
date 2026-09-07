'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { memorySourceError, throwIfAborted } = require('./contracts.cjs');

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameIdentityExceptCtime(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function isWritableFlags(flags) {
  return (flags & fs.constants.O_WRONLY) === fs.constants.O_WRONLY
    || (flags & fs.constants.O_RDWR) === fs.constants.O_RDWR;
}

function acceptsWritableOpenCtimeDrift(pathStat, openedStat, pathRestat, flags) {
  return isWritableFlags(flags)
    && pathStat.ctimeNs !== openedStat.ctimeNs
    && sameIdentityExceptCtime(fileIdentity(pathStat), fileIdentity(openedStat))
    && pathRestat?.isFile?.()
    && !pathRestat?.isSymbolicLink?.()
    && sameIdentity(fileIdentity(pathRestat), fileIdentity(openedStat));
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function portableFileIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
  });
}

function samePortableIdentity(stat, expected) {
  return Boolean(stat && expected
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino
    && String(stat.size) === expected.size);
}

function ensureNoFollowAvailable() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw memorySourceError('invalid_memory_source', 'O_NOFOLLOW unavailable', {
      retryable: false,
    });
  }
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function realpathCanonical(candidate, code) {
  try {
    return await fsp.realpath(candidate);
  } catch (error) {
    throw memorySourceError(code, code, { cause: error, retryable: code === 'source_unavailable' });
  }
}

async function openConfinedRegularFile(root, filePath, options = {}) {
  throwIfAborted(options.signal);
  ensureNoFollowAvailable();
  if (typeof root !== 'string' || typeof filePath !== 'string'
      || !path.isAbsolute(root) || !path.isAbsolute(filePath)
      || root.includes('\0') || filePath.includes('\0')) {
    throw memorySourceError('invalid_request');
  }
  let rootStat;
  let pathStat;
  try {
    rootStat = await fsp.lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw memorySourceError('invalid_memory_source', 'root is not canonical', { retryable: false });
    }
    pathStat = await fsp.lstat(filePath, { bigint: true });
  } catch (error) {
    if (options.optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'invalid_memory_source') throw error;
    throw memorySourceError('source_unavailable', 'source unavailable', {
      cause: error,
      retryable: true,
    });
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw memorySourceError('invalid_memory_source', 'source is not a regular file', {
      retryable: false,
    });
  }
  if (options.maxBytes !== undefined
      && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0
        || Number(pathStat.size) > options.maxBytes)) {
    throw memorySourceError('result_too_large', 'file limit exceeded', {
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: options.maxBytes,
    });
  }
  const rootReal = await realpathCanonical(root, 'invalid_memory_source');
  const fileReal = await realpathCanonical(filePath, 'source_unavailable');
  if (!isInside(rootReal, fileReal)) {
    throw memorySourceError('invalid_memory_source', 'source escapes root', { retryable: false });
  }
  const flags = options.flags ?? fs.constants.O_RDONLY;
  let handle;
  try {
    handle = await fsp.open(filePath, flags | fs.constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    let stableIdentity = opened.isFile()
      && sameIdentity(fileIdentity(pathStat), fileIdentity(opened));
    if (!stableIdentity
        && opened.isFile()
        && isWritableFlags(flags)
        && sameIdentityExceptCtime(fileIdentity(pathStat), fileIdentity(opened))) {
      const pathRestat = await fsp.lstat(filePath, { bigint: true });
      stableIdentity = acceptsWritableOpenCtimeDrift(pathStat, opened, pathRestat, flags);
    }
    if (!stableIdentity) {
      throw memorySourceError('invalid_memory_source', 'source changed while opening', {
        retryable: false,
      });
    }
    return {
      handle,
      path: filePath,
      realpath: fileReal,
      stat: opened,
      identity: fileIdentity(opened),
      // Preserve the exact pre-open pathname identity. Writable opens may
      // legitimately move ctime on some platforms, but mutation authority
      // must compare the state that existed before the descriptor was opened.
      pathIdentity: fileIdentity(pathStat),
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'invalid_memory_source' || error?.code === 'result_too_large') throw error;
    throw memorySourceError('source_unavailable', 'source unavailable', {
      cause: error,
      retryable: true,
    });
  }
}

async function assertStableOpenedFile(opened) {
  const current = await opened.handle.stat({ bigint: true });
  if (!current.isFile() || !sameIdentity(opened.identity, fileIdentity(current))) {
    throw memorySourceError('source_changed', 'source changed while reading', { retryable: true });
  }
}

async function assertStableOpenedFileContent(opened) {
  const current = await opened.handle.stat({ bigint: true });
  if (!current.isFile()
      || current.dev !== opened.identity.dev
      || current.ino !== opened.identity.ino
      || current.size !== opened.identity.size
      || current.mtimeNs !== opened.identity.mtimeNs) {
    throw memorySourceError('source_changed', 'source changed while reading', { retryable: true });
  }
}

async function assertOpenedFilePathIdentity(opened, expected = portableFileIdentity(opened.stat)) {
  let handleStat;
  let pathStat;
  try {
    [handleStat, pathStat] = await Promise.all([
      opened.handle.stat({ bigint: true }),
      fsp.lstat(opened.path, { bigint: true }),
    ]);
  } catch (cause) {
    throw memorySourceError('source_changed', 'source pathname changed', {
      cause,
      retryable: true,
    });
  }
  if (!handleStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
      || !samePortableIdentity(handleStat, expected)
      || !samePortableIdentity(pathStat, expected)) {
    throw memorySourceError('source_changed', 'source pathname identity changed', {
      retryable: true,
    });
  }
  return handleStat;
}

async function readOpenedFile(opened, { maxBytes } = {}) {
  let stat;
  try {
    stat = await opened.handle.stat({ bigint: true });
  } catch (cause) {
    throw memorySourceError('source_changed', 'opened source is unavailable', {
      cause,
      retryable: true,
    });
  }
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw memorySourceError('source_unavailable', 'opened source size is invalid', {
      retryable: true,
    });
  }
  if (maxBytes !== undefined
      && (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes)) {
    throw memorySourceError('result_too_large', 'file limit exceeded', {
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: maxBytes,
    });
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await opened.handle.read(bytes, offset, size - offset, offset);
    if (bytesRead <= 0) {
      throw memorySourceError('source_changed', 'opened source was truncated', {
        retryable: true,
      });
    }
    offset += bytesRead;
  }
  await assertStableOpenedFileContent(opened);
  return bytes;
}

async function assertStableOpenedFilePrefix(opened, { bytes, sha256 }) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/.test(sha256 || '')) {
    throw memorySourceError('invalid_request', 'valid opened-file prefix required');
  }
  const current = await opened.handle.stat({ bigint: true });
  if (!current.isFile()
      || current.dev !== opened.identity.dev
      || current.ino !== opened.identity.ino
      || Number(current.size) < bytes) {
    throw memorySourceError('source_changed', 'source prefix changed while reading', {
      retryable: true,
    });
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, bytes)));
  let position = 0;
  while (position < bytes) {
    const length = Math.min(buffer.length, bytes - position);
    const { bytesRead } = await opened.handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) {
      throw memorySourceError('source_changed', 'source prefix truncated while validating', {
        retryable: true,
      });
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (hash.digest('hex') !== sha256) {
    throw memorySourceError('source_changed', 'source prefix changed while reading', {
      retryable: true,
    });
  }
  const after = await opened.handle.stat({ bigint: true });
  if (!after.isFile()
      || after.dev !== opened.identity.dev
      || after.ino !== opened.identity.ino
      || Number(after.size) < bytes) {
    throw memorySourceError('source_changed', 'source prefix changed while validating', {
      retryable: true,
    });
  }
}

async function readConfinedFile(root, filePath, options = {}) {
  const opened = await openConfinedRegularFile(root, filePath, options);
  if (opened === null) return null;
  try {
    const bytes = await readOpenedFile(opened, { maxBytes: options.maxBytes });
    await assertStableOpenedFile(opened);
    await assertOpenedFilePathIdentity(opened, portableFileIdentity(opened.stat));
    return bytes;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

module.exports = {
  acceptsWritableOpenCtimeDrift,
  openConfinedRegularFile,
  portableFileIdentity,
  assertStableOpenedFile,
  assertStableOpenedFileContent,
  assertOpenedFilePathIdentity,
  assertStableOpenedFilePrefix,
  readOpenedFile,
  readConfinedFile,
};
