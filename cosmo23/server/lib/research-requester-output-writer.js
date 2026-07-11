'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const {
  throwIfAborted,
} = require('../../../shared/memory-source/contracts.cjs');

const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MAX_BASENAME_BYTES = 255;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function writerError(code, message = code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    retryable: false,
  });
}

function invalidRequest(message = 'invalid requester output request') {
  return writerError('invalid_request', message);
}

function boundaryError(code, message, cause) {
  return writerError(code, message, cause);
}

function identity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(stat, expected) {
  return stat.dev === expected.dev && stat.ino === expected.ino;
}

function assertNoFollowSupport() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)
      || !Number.isInteger(fs.constants.O_DIRECTORY)) {
    throw boundaryError('output_boundary_invalid', 'no-follow directory operations unavailable');
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function statDirectory(directory, code) {
  let stat;
  try {
    stat = await fsp.lstat(directory, { bigint: true });
  } catch (error) {
    throw boundaryError(code, 'requester output directory is unavailable', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw boundaryError(code, 'requester output component is not a nonsymlink directory');
  }
  return stat;
}

async function openDirectoryNoFollow(directory, expectedIdentity, code) {
  let handle;
  try {
    handle = await fsp.open(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(opened, expectedIdentity)) {
      throw boundaryError(code, 'requester output directory changed while opening');
    }
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === code) throw error;
    throw boundaryError(code, 'requester output directory cannot be opened safely', error);
  }
}

async function captureDirectoryChain(home23Root, requesterAgent) {
  assertNoFollowSupport();
  if (typeof home23Root !== 'string' || !home23Root || home23Root.includes('\0')
      || !path.isAbsolute(home23Root) || path.normalize(home23Root) !== home23Root) {
    throw invalidRequest('home23Root must be an absolute normalized path');
  }
  if (typeof requesterAgent !== 'string' || !AGENT_PATTERN.test(requesterAgent)) {
    throw invalidRequest('requesterAgent is invalid');
  }

  const suppliedRootStat = await statDirectory(home23Root, 'output_boundary_invalid');
  let canonicalRoot;
  try {
    canonicalRoot = await fsp.realpath(home23Root);
  } catch (error) {
    throw boundaryError('output_boundary_invalid', 'home23Root cannot be resolved', error);
  }
  const canonicalRootStat = await statDirectory(canonicalRoot, 'output_boundary_invalid');
  if (!sameIdentity(suppliedRootStat, identity(canonicalRootStat))) {
    throw boundaryError('output_boundary_invalid', 'home23Root changed while resolving');
  }

  const directories = [
    canonicalRoot,
    path.join(canonicalRoot, 'instances'),
    path.join(canonicalRoot, 'instances', requesterAgent),
    path.join(canonicalRoot, 'instances', requesterAgent, 'workspace'),
  ];
  const outputRoot = path.join(directories[directories.length - 1], 'research');
  if (!isInside(canonicalRoot, outputRoot)) throw invalidRequest('requester workspace escaped home23Root');

  const captures = new Map();
  for (const directory of directories) {
    const stat = await statDirectory(directory, 'output_boundary_invalid');
    let canonical;
    try {
      canonical = await fsp.realpath(directory);
    } catch (error) {
      throw boundaryError('output_boundary_invalid', 'requester workspace cannot be resolved', error);
    }
    if (canonical !== directory) {
      throw boundaryError('output_boundary_invalid', 'requester workspace contains a symlink');
    }
    captures.set(directory, identity(stat));
  }

  try {
    await fsp.mkdir(outputRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw boundaryError('output_boundary_invalid', 'requester research directory cannot be created', error);
    }
  }
  const outputStat = await statDirectory(outputRoot, 'output_boundary_invalid');
  let canonicalOutput;
  try {
    canonicalOutput = await fsp.realpath(outputRoot);
  } catch (error) {
    throw boundaryError('output_boundary_invalid', 'requester research directory cannot be resolved', error);
  }
  if (canonicalOutput !== outputRoot) {
    throw boundaryError('output_boundary_invalid', 'requester research directory is a symlink');
  }
  captures.set(outputRoot, identity(outputStat));

  const handle = await openDirectoryNoFollow(
    outputRoot,
    captures.get(outputRoot),
    'output_boundary_invalid',
  );
  await handle.close();

  return Object.freeze({
    canonicalRoot,
    outputRoot,
    workspaceRoot: directories[directories.length - 1],
    captures,
  });
}

async function verifyDirectoryChain(boundary) {
  for (const [directory, expected] of boundary.captures) {
    let stat;
    let canonical;
    try {
      stat = await fsp.lstat(directory, { bigint: true });
      canonical = await fsp.realpath(directory);
    } catch (error) {
      throw boundaryError('output_boundary_changed', 'requester output boundary changed', error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)
        || canonical !== directory) {
      throw boundaryError('output_boundary_changed', 'requester output boundary changed');
    }
  }
}

function validateBasename(fileName) {
  if (typeof fileName !== 'string' || !fileName || fileName.includes('\0')
      || fileName === '.' || fileName === '..'
      || path.isAbsolute(fileName) || path.win32.isAbsolute(fileName)
      || fileName.includes('/') || fileName.includes('\\')
      || path.basename(fileName) !== fileName || path.win32.basename(fileName) !== fileName
      || Buffer.byteLength(fileName, 'utf8') > MAX_BASENAME_BYTES) {
    throw invalidRequest('output name must be one relative basename');
  }
  return fileName;
}

function validateBytes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw invalidRequest('output bytes must be a Buffer or Uint8Array');
  }
  const value = Buffer.from(bytes);
  if (value.length > MAX_OUTPUT_BYTES) {
    throw writerError('result_too_large', 'requester output exceeds the bounded byte limit');
  }
  return value;
}

async function optionalDestinationIdentity(destinationPath) {
  try {
    const stat = await fsp.lstat(destinationPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw boundaryError('output_boundary_invalid', 'output destination is not a nonsymlink regular file');
    }
    return identity(stat);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'output_boundary_invalid') throw error;
    throw boundaryError('output_boundary_invalid', 'output destination cannot be inspected', error);
  }
}

async function verifyDestinationUnchanged(destinationPath, priorIdentity) {
  try {
    const current = await fsp.lstat(destinationPath, { bigint: true });
    if (priorIdentity === null || !current.isFile() || current.isSymbolicLink()
        || current.nlink !== 1n || !sameIdentity(current, priorIdentity)) {
      throw boundaryError('output_boundary_changed', 'output destination changed before publication');
    }
  } catch (error) {
    if (error?.code === 'ENOENT' && priorIdentity === null) return;
    if (error?.code === 'output_boundary_changed') throw error;
    throw boundaryError('output_boundary_changed', 'output destination changed before publication', error);
  }
}

async function removeOwnedTemp(tempPath, tempIdentity) {
  if (!tempIdentity) return;
  try {
    const stat = await fsp.lstat(tempPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
        || !sameIdentity(stat, tempIdentity)) return;
    await fsp.unlink(tempPath);
  } catch {}
}

async function createRequesterOutputWriter({
  home23Root,
  requesterAgent,
  operationId,
  signal,
} = {}) {
  throwIfAborted(signal);
  if (typeof operationId !== 'string' || !OPERATION_PATTERN.test(operationId)) {
    throw invalidRequest('operationId is invalid');
  }
  const boundary = await captureDirectoryChain(home23Root, requesterAgent);
  throwIfAborted(signal);

  async function writeAtomic(relativeBasename, bytes) {
    throwIfAborted(signal);
    const basename = validateBasename(relativeBasename);
    const output = validateBytes(bytes);
    await verifyDirectoryChain(boundary);
    throwIfAborted(signal);

    const outputIdentity = boundary.captures.get(boundary.outputRoot);
    const destinationPath = path.join(boundary.outputRoot, basename);
    const tempPath = path.join(
      boundary.outputRoot,
      `.${basename}.${operationId}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    const directoryHandle = await openDirectoryNoFollow(
      boundary.outputRoot,
      outputIdentity,
      'output_boundary_changed',
    );
    let priorDestination;
    let tempHandle;
    let tempIdentity = null;
    let renamed = false;
    try {
      priorDestination = await optionalDestinationIdentity(destinationPath);
      tempHandle = await fsp.open(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await tempHandle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) {
        throw boundaryError('output_boundary_changed', 'temporary output is not a private regular file');
      }
      tempIdentity = identity(opened);
      let canonicalTemp;
      try {
        canonicalTemp = await fsp.realpath(tempPath);
      } catch (error) {
        throw boundaryError('output_boundary_changed', 'temporary output cannot be resolved', error);
      }
      if (path.dirname(canonicalTemp) !== boundary.outputRoot) {
        throw boundaryError('output_boundary_changed', 'temporary output escaped requester research directory');
      }

      await tempHandle.writeFile(output);
      await tempHandle.sync();
      throwIfAborted(signal);

      const openedAfter = await tempHandle.stat({ bigint: true });
      const pathAfter = await fsp.lstat(tempPath, { bigint: true });
      if (!openedAfter.isFile() || openedAfter.nlink !== 1n || openedAfter.size !== BigInt(output.length)
          || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n
          || !sameIdentity(openedAfter, tempIdentity) || !sameIdentity(pathAfter, tempIdentity)) {
        throw boundaryError('output_boundary_changed', 'temporary output changed before publication');
      }

      await verifyDirectoryChain(boundary);
      await verifyDestinationUnchanged(destinationPath, priorDestination);
      throwIfAborted(signal);
      await tempHandle.close();
      tempHandle = null;

      await verifyDirectoryChain(boundary);
      await verifyDestinationUnchanged(destinationPath, priorDestination);
      throwIfAborted(signal);
      await fsp.rename(tempPath, destinationPath);
      renamed = true;
      await directoryHandle.sync();

      const published = await fsp.lstat(destinationPath, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n
          || published.size !== BigInt(output.length) || !sameIdentity(published, tempIdentity)) {
        throw boundaryError('output_boundary_changed', 'published requester output is invalid');
      }
      await verifyDirectoryChain(boundary);
      return {
        relativePath: path.posix.join('research', basename),
        bytes: output.length,
      };
    } catch (error) {
      if (signal?.aborted && !renamed) throw signal.reason || error;
      if (['invalid_request', 'result_too_large', 'output_boundary_invalid',
        'output_boundary_changed'].includes(error?.code)) throw error;
      throw writerError('output_write_failed', 'requester output could not be written', error);
    } finally {
      if (tempHandle) await tempHandle.close().catch(() => {});
      if (!renamed) await removeOwnedTemp(tempPath, tempIdentity);
      await directoryHandle.close().catch(() => {});
    }
  }

  return Object.freeze({ writeAtomic });
}

module.exports = {
  createRequesterOutputWriter,
};
