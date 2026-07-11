'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');

const CANONICAL_RUN_METADATA_BASENAME = 'home23-research-run.json';
const MAX_RUN_METADATA_BYTES = 256 * 1024;

function metadataError(code, message = code, cause, retryable = false) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    retryable,
  });
}

function knownError(error) {
  return [
    'invalid_request',
    'run_metadata_boundary_invalid',
    'run_metadata_boundary_changed',
    'run_metadata_invalid',
    'run_metadata_too_large',
    'run_metadata_unavailable',
  ].includes(error?.code);
}

function assertNoFollowSupport() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)
      || !Number.isInteger(fs.constants.O_DIRECTORY)) {
    throw metadataError(
      'run_metadata_boundary_invalid',
      'No-follow filesystem operations are unavailable',
    );
  }
}

function assertCanonicalRunRoot(runRoot) {
  if (typeof runRoot !== 'string'
      || !runRoot
      || runRoot.includes('\0')
      || /[\u0000-\u001f\u007f]/.test(runRoot)
      || !path.isAbsolute(runRoot)
      || path.normalize(runRoot) !== runRoot
      || path.dirname(runRoot) === runRoot) {
    throw metadataError('invalid_request', 'runRoot must be a canonical absolute directory');
  }
  return runRoot;
}

function inodeIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameInode(stat, expected) {
  return stat.dev === expected.dev && stat.ino === expected.ino;
}

function sameFile(stat, expected) {
  return sameInode(stat, expected)
    && stat.size === expected.size
    && stat.mtimeNs === expected.mtimeNs
    && stat.ctimeNs === expected.ctimeNs;
}

function assertPrivateRegularFile(stat, code = 'run_metadata_boundary_invalid') {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw metadataError(code, 'Canonical run metadata is not a private regular file');
  }
}

async function captureRunRoot(runRoot) {
  assertNoFollowSupport();
  const root = assertCanonicalRunRoot(runRoot);
  let pathStat;
  let canonical;
  let handle;
  try {
    pathStat = await fsp.lstat(root, { bigint: true });
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
      throw metadataError(
        'run_metadata_boundary_invalid',
        'Canonical research run root is not a nonsymlink directory',
      );
    }
    canonical = await fsp.realpath(root);
    if (canonical !== root) {
      throw metadataError(
        'run_metadata_boundary_invalid',
        'Canonical research run root traverses a symlink',
      );
    }
    handle = await fsp.open(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameInode(opened, inodeIdentity(pathStat))) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Canonical research run root changed while opening',
      );
    }
    return Object.freeze({ root, identity: inodeIdentity(opened), handle });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (knownError(error)) throw error;
    throw metadataError(
      'run_metadata_boundary_invalid',
      'Canonical research run root cannot be opened safely',
      error,
    );
  }
}

async function verifyRunRoot(boundary) {
  let stat;
  let canonical;
  let opened;
  try {
    [stat, canonical, opened] = await Promise.all([
      fsp.lstat(boundary.root, { bigint: true }),
      fsp.realpath(boundary.root),
      boundary.handle.stat({ bigint: true }),
    ]);
  } catch (error) {
    throw metadataError(
      'run_metadata_boundary_changed',
      'Canonical research run root changed',
      error,
    );
  }
  if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || !opened.isDirectory()
      || canonical !== boundary.root
      || !sameInode(stat, boundary.identity)
      || !sameInode(opened, boundary.identity)) {
    throw metadataError(
      'run_metadata_boundary_changed',
      'Canonical research run root changed',
    );
  }
}

function canonicalMetadataBytes(record) {
  let json;
  try {
    json = canonicalJson(record);
  } catch (error) {
    throw metadataError('run_metadata_invalid', 'Canonical research run metadata is invalid', error);
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw metadataError('run_metadata_invalid', 'Canonical research run metadata is invalid', error);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw metadataError('run_metadata_invalid', 'Canonical research run metadata must be an object');
  }
  const bytes = Buffer.from(`${json}\n`, 'utf8');
  if (bytes.length > MAX_RUN_METADATA_BYTES) {
    throw metadataError(
      'run_metadata_too_large',
      'Canonical research run metadata exceeds its bounded byte limit',
    );
  }
  return bytes;
}

async function inspectMetadataPath(metadataPath, { optional = false } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(metadataPath, { bigint: true });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  assertPrivateRegularFile(stat);
  if (stat.size > BigInt(MAX_RUN_METADATA_BYTES)) {
    throw metadataError(
      'run_metadata_too_large',
      'Canonical research run metadata exceeds its bounded byte limit',
    );
  }
  let canonical;
  try {
    canonical = await fsp.realpath(metadataPath);
  } catch (error) {
    throw metadataError(
      'run_metadata_boundary_invalid',
      'Canonical research run metadata cannot be resolved safely',
      error,
    );
  }
  if (canonical !== metadataPath) {
    throw metadataError(
      'run_metadata_boundary_invalid',
      'Canonical research run metadata traverses a symlink',
    );
  }
  return Object.freeze({ identity: fileIdentity(stat), stat });
}

async function readBounded(handle) {
  const output = Buffer.allocUnsafe(MAX_RUN_METADATA_BYTES + 1);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_RUN_METADATA_BYTES) {
    throw metadataError(
      'run_metadata_too_large',
      'Canonical research run metadata exceeds its bounded byte limit',
    );
  }
  return output.subarray(0, offset);
}

async function loadCanonicalRunMetadata(runRoot) {
  const boundary = await captureRunRoot(runRoot);
  const metadataPath = path.join(boundary.root, CANONICAL_RUN_METADATA_BASENAME);
  let handle;
  let metadataObserved = false;
  try {
    const inspected = await inspectMetadataPath(metadataPath);
    metadataObserved = true;
    await verifyRunRoot(boundary);
    handle = await fsp.open(metadataPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    assertPrivateRegularFile(opened, 'run_metadata_boundary_changed');
    if (!sameFile(opened, inspected.identity)) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Canonical research run metadata changed while opening',
      );
    }
    const bytes = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    if (!sameFile(after, inspected.identity)) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Canonical research run metadata changed while reading',
      );
    }
    await verifyRunRoot(boundary);

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw metadataError('run_metadata_invalid', 'Canonical research run metadata is invalid JSON', error);
    }
    const canonical = canonicalMetadataBytes(parsed);
    return JSON.parse(canonical.toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && !metadataObserved) throw error;
    if (error?.code === 'ENOENT') {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Canonical research run metadata disappeared while opening',
        error,
      );
    }
    if (knownError(error)) throw error;
    throw metadataError(
      'run_metadata_unavailable',
      'Canonical research run metadata cannot be read',
      error,
      true,
    );
  } finally {
    if (handle) await handle.close().catch(() => {});
    await boundary.handle.close().catch(() => {});
  }
}

async function verifyDestination(metadataPath, prior) {
  let current;
  try {
    current = await fsp.lstat(metadataPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' && prior === null) return;
    throw metadataError(
      'run_metadata_boundary_changed',
      'Canonical research run metadata destination changed',
      error,
    );
  }
  if (prior === null) {
    throw metadataError(
      'run_metadata_boundary_changed',
      'Canonical research run metadata destination appeared before publication',
    );
  }
  assertPrivateRegularFile(current, 'run_metadata_boundary_changed');
  if (!sameFile(current, prior.identity)) {
    throw metadataError(
      'run_metadata_boundary_changed',
      'Canonical research run metadata destination changed before publication',
    );
  }
}

async function removeOwnedTemp(tempPath, expectedIdentity) {
  if (!expectedIdentity) return;
  try {
    const stat = await fsp.lstat(tempPath, { bigint: true });
    if (stat.isFile()
        && !stat.isSymbolicLink()
        && stat.nlink === 1n
        && sameInode(stat, expectedIdentity)) {
      await fsp.unlink(tempPath);
    }
  } catch {}
}

async function writeCanonicalRunMetadataAtomic(runRoot, record) {
  const bytes = canonicalMetadataBytes(record);
  const boundary = await captureRunRoot(runRoot);
  const metadataPath = path.join(boundary.root, CANONICAL_RUN_METADATA_BASENAME);
  const tempPath = path.join(
    boundary.root,
    `.${CANONICAL_RUN_METADATA_BASENAME}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`,
  );
  let tempHandle;
  let tempIdentity = null;
  let renamed = false;
  try {
    const prior = await inspectMetadataPath(metadataPath, { optional: true });
    await verifyRunRoot(boundary);
    tempHandle = await fsp.open(
      tempPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const opened = await tempHandle.stat({ bigint: true });
    assertPrivateRegularFile(opened, 'run_metadata_boundary_changed');
    tempIdentity = inodeIdentity(opened);
    let canonicalTemp;
    try {
      canonicalTemp = await fsp.realpath(tempPath);
    } catch (error) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Temporary run metadata cannot be resolved safely',
        error,
      );
    }
    if (canonicalTemp !== tempPath) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Temporary run metadata escaped its canonical root',
      );
    }

    await tempHandle.writeFile(bytes);
    await tempHandle.sync();
    const [openedAfter, pathAfter] = await Promise.all([
      tempHandle.stat({ bigint: true }),
      fsp.lstat(tempPath, { bigint: true }),
    ]);
    assertPrivateRegularFile(openedAfter, 'run_metadata_boundary_changed');
    assertPrivateRegularFile(pathAfter, 'run_metadata_boundary_changed');
    if (!sameInode(openedAfter, tempIdentity)
        || !sameInode(pathAfter, tempIdentity)
        || openedAfter.size !== BigInt(bytes.length)
        || pathAfter.size !== BigInt(bytes.length)) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Temporary run metadata changed before publication',
      );
    }

    await verifyRunRoot(boundary);
    await verifyDestination(metadataPath, prior);
    await tempHandle.close();
    tempHandle = null;
    await verifyRunRoot(boundary);
    await verifyDestination(metadataPath, prior);
    await fsp.rename(tempPath, metadataPath);
    renamed = true;
    await boundary.handle.sync();

    const published = await fsp.lstat(metadataPath, { bigint: true });
    assertPrivateRegularFile(published, 'run_metadata_boundary_changed');
    if (!sameInode(published, tempIdentity) || published.size !== BigInt(bytes.length)) {
      throw metadataError(
        'run_metadata_boundary_changed',
        'Published canonical run metadata is invalid',
      );
    }
    await verifyRunRoot(boundary);
  } catch (error) {
    if (knownError(error)) throw error;
    throw metadataError(
      'run_metadata_unavailable',
      'Canonical research run metadata cannot be written durably',
      error,
      true,
    );
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => {});
    if (!renamed) await removeOwnedTemp(tempPath, tempIdentity);
    await boundary.handle.close().catch(() => {});
  }
}

module.exports = {
  CANONICAL_RUN_METADATA_BASENAME,
  MAX_RUN_METADATA_BYTES,
  loadCanonicalRunMetadata,
  writeCanonicalRunMetadataAtomic,
};
