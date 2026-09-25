'use strict';

/**
 * Reseal a brain manifest whose committed delta file identity drifted.
 *
 * memory-manifest.json seals activeDelta.fileIdentity (dev/ino/size/mtimeNs/
 * ctimeNs) so readers and the writer refuse a delta whose committed prefix
 * changed underneath them. Restoring, moving or copying a brain to another
 * volume gives the same bytes a new inode and ctime (and, when the copy does
 * not preserve timestamps, a new mtime), so every identity-checked read fails
 * with source_changed until the seal is renewed. Reseal proves the committed
 * prefix unchanged, then rewrites only the identity.
 *
 * Callers reseal a brain with no live writer (a stopped or freshly restored
 * home). inspectMemorySeal is read-only and safe on a live home.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { memorySourceError } = require('./contracts.cjs');
const { readManifest, writeManifestAtomic } = require('./manifest.cjs');
const {
  openConfinedRegularFile,
  committedFileIdentity,
  sameCommittedContent,
} = require('./confined-file.cjs');

const MEMORY_SEAL_STALE = 'memory_seal_stale';
const MEMORY_SEAL_CONTENT_CHANGED = 'memory_seal_content_changed';

async function statCommittedDelta(brainDir, manifest) {
  const deltaPath = path.join(brainDir, manifest.activeDelta.file);
  let stat;
  try {
    stat = await fsp.lstat(deltaPath, { bigint: true });
  } catch (cause) {
    throw memorySourceError('source_unavailable', 'committed delta unavailable', {
      cause,
      retryable: true,
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw memorySourceError('invalid_memory_source', 'delta must be a regular nonsymlink file', {
      retryable: false,
    });
  }
  return { deltaPath, stat };
}

/**
 * Compare the sealed delta identity with the file on disk without writing.
 * status: 'absent' (no manifest), 'unsealed' (the manifest carries no
 * identity), 'sealed' (identity matches; a dev-only difference is a remount,
 * not drift), 'stale' (same size, other identity fields differ) or 'changed'
 * (size differs from the sealed cutoff).
 */
async function inspectMemorySeal(brainDir) {
  const manifest = await readManifest(brainDir);
  if (!manifest) return Object.freeze({ status: 'absent', file: null, manifest: null });
  const file = manifest.activeDelta.file;
  const sealed = manifest.activeDelta.fileIdentity;
  if (!sealed) return Object.freeze({ status: 'unsealed', file, manifest });
  const { stat } = await statCommittedDelta(brainDir, manifest);
  const current = committedFileIdentity(stat);
  const status = sameCommittedContent(stat, sealed) ? 'sealed'
    : current.size !== sealed.size ? 'changed'
      : 'stale';
  return Object.freeze({ status, file, manifest, sealed, current });
}

function contentChanged(message, fields = {}) {
  return memorySourceError(MEMORY_SEAL_CONTENT_CHANGED, message, { retryable: false, ...fields });
}

/** Returns how the committed prefix was proven unchanged, or null when it cannot be. */
async function verifyCommittedDeltaContent(brainDir, manifest, signal) {
  const activeDelta = manifest.activeDelta;
  if (activeDelta.committedBytes === 0) return 'empty';
  if (typeof activeDelta.chainDigest !== 'string') return null;
  // Lazy: the writer is the chain authority's owner and is not needed for inspection.
  const { validateCommittedDeltaChain } = require('./writer.cjs');
  const deltaPath = path.join(brainDir, activeDelta.file);
  const opened = await openConfinedRegularFile(brainDir, deltaPath, {
    flags: fs.constants.O_RDONLY,
  });
  try {
    await validateCommittedDeltaChain(brainDir, deltaPath, opened, manifest, signal);
  } finally {
    await opened.handle.close().catch(() => {});
  }
  return 'chain';
}

/**
 * Rewrite activeDelta.fileIdentity to the committed delta on disk when only
 * the file's identity drifted. A matching mtime proves the bytes untouched;
 * otherwise the delta chain authority must verify the committed prefix.
 * Throws memory_seal_content_changed when the prefix cannot be shown
 * unchanged: its size differs from the sealed cutoff, the chain does not
 * verify, or the mtime differs and the manifest has no chain authority.
 */
async function resealMemoryManifest(brainDir, options = {}) {
  const seal = await inspectMemorySeal(brainDir);
  if (seal.status !== 'stale' && seal.status !== 'changed') {
    return Object.freeze({ ...seal, resealed: false });
  }
  if (seal.status === 'changed') {
    throw contentChanged(
      `committed delta ${seal.file} is ${seal.current.size} bytes; the manifest sealed ${seal.sealed.size}`,
      { file: seal.file, sealed: seal.sealed, current: seal.current },
    );
  }
  let verifiedBy = 'mtime';
  if (seal.current.mtimeNs !== seal.sealed.mtimeNs) {
    let verified;
    try {
      verified = await verifyCommittedDeltaContent(brainDir, seal.manifest, options.signal);
    } catch (cause) {
      if (cause?.code !== 'source_changed') throw cause;
      throw contentChanged(
        `committed delta ${seal.file} content differs from its sealed chain: ${cause.message}`,
        { file: seal.file, cause },
      );
    }
    if (!verified) {
      throw contentChanged(
        `committed delta ${seal.file} mtime differs and the manifest has no chain authority to verify its content`,
        { file: seal.file },
      );
    }
    verifiedBy = verified;
  }
  const { stat } = await statCommittedDelta(brainDir, seal.manifest);
  if (!sameCommittedContent(stat, seal.current)) {
    throw memorySourceError('source_changed', 'committed delta changed during reseal', {
      retryable: true,
    });
  }
  const manifest = await writeManifestAtomic(brainDir, {
    ...seal.manifest,
    activeDelta: { ...seal.manifest.activeDelta, fileIdentity: committedFileIdentity(stat) },
  });
  return Object.freeze({
    status: 'resealed',
    resealed: true,
    file: seal.file,
    manifest,
    sealed: seal.sealed,
    current: seal.current,
    verifiedBy,
  });
}

module.exports = {
  MEMORY_SEAL_STALE,
  MEMORY_SEAL_CONTENT_CHANGED,
  inspectMemorySeal,
  resealMemoryManifest,
};
