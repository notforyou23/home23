'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {
  memorySourceError,
  throwIfAborted,
} = require('./contracts.cjs');
const {
  openConfinedRegularFile,
  readConfinedFile,
  assertStableOpenedFileContent,
  assertOpenedFilePathIdentity,
  portableFileIdentity,
} = require('./confined-file.cjs');
const {
  readManifest,
  resolveMemorySourceSelection,
  writeManifestAtomic,
  fsyncDirectory,
} = require('./manifest.cjs');
const { withMemorySourceLock } = require('./pins.cjs');
const { projectLegacyResidentSidecars } = require('./legacy-projection.cjs');

const DEFAULT_MIN_FREE_BYTES = 4 * 1024 ** 3;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_PROJECTION_INTEGRITY_BYTES = 1024 * 1024;

function validSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function availableBytes(stats) {
  const blocks = stats.bavail ?? stats.bfree;
  const blockSize = stats.bsize ?? stats.frsize;
  if (blocks === undefined || blockSize === undefined) {
    throw memorySourceError('source_unavailable', 'filesystem capacity is unavailable', { retryable: true });
  }
  return BigInt(blocks) * BigInt(blockSize);
}

function assertCapacity({ available, required, phase, capacityDomain }) {
  if (available < required) {
    throw memorySourceError('insufficient_disk', `insufficient disk for legacy migration ${phase}`, {
      retryable: false,
      availableBytes: available.toString(),
      requiredBytes: required.toString(),
      capacityDomain,
    });
  }
}

async function defaultDeviceImpl(directory) {
  return (await fsp.stat(directory, { bigint: true })).dev;
}

async function assertLegacyMigrationPreflightCapacity({
  brainDir,
  scratchDir,
  sourceBytes,
  minFreeBytes,
  statfsImpl = fsp.statfs,
  deviceImpl = defaultDeviceImpl,
}) {
  const reserve = BigInt(minFreeBytes);
  const input = BigInt(sourceBytes);
  const [targetStatfs, scratchStatfs, targetDevice, scratchDevice] = await Promise.all([
    statfsImpl(brainDir, { bigint: true }),
    statfsImpl(scratchDir, { bigint: true }),
    deviceImpl(brainDir),
    deviceImpl(scratchDir),
  ]);
  const targetAvailable = availableBytes(targetStatfs);
  const scratchAvailable = availableBytes(scratchStatfs);
  const sharedFilesystem = String(targetDevice) === String(scratchDevice);
  if (sharedFilesystem) {
    const required = reserve + (input * 2n);
    assertCapacity({
      available: targetAvailable < scratchAvailable ? targetAvailable : scratchAvailable,
      required,
      phase: 'preflight',
      capacityDomain: 'shared',
    });
    return {
      sharedFilesystem,
      targetAvailable,
      scratchAvailable,
      targetRequired: required,
      scratchRequired: required,
    };
  }
  const required = reserve + input;
  assertCapacity({
    available: targetAvailable,
    required,
    phase: 'preflight',
    capacityDomain: 'target',
  });
  assertCapacity({
    available: scratchAvailable,
    required,
    phase: 'preflight',
    capacityDomain: 'scratch',
  });
  return {
    sharedFilesystem,
    targetAvailable,
    scratchAvailable,
    targetRequired: required,
    scratchRequired: required,
  };
}

async function sumLegacyInputBytes(selection) {
  let total = 0n;
  for (const entry of selection.targetFiles) {
    if (!entry.role.startsWith('legacy-')) continue;
    const stat = await fsp.lstat(entry.path).catch((error) => {
      if (entry.optional && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw memorySourceError('invalid_memory_source', 'legacy migration source must be a regular file');
    }
    total += BigInt(stat.size);
  }
  return total;
}

async function writeAll(handle, buffer, length, position) {
  let written = 0;
  while (written < length) {
    const result = await handle.write(buffer, written, length - written, position + written);
    if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw memorySourceError('source_unavailable', 'migration copy made no progress', { retryable: true });
    }
    written += result.bytesWritten;
  }
}

function directoryIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(stat, identity) {
  return Boolean(stat && identity && stat.dev === identity.dev && stat.ino === identity.ino);
}

async function lstatOptional(candidate) {
  return fsp.lstat(candidate, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertOwnedDirectory(directoryPath, identity, label) {
  const stat = await lstatOptional(directoryPath);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat, identity)) {
    throw memorySourceError('invalid_memory_source', `${label} identity changed`, {
      retryable: false,
    });
  }
}

async function removeOwnedDirectory(directoryPath, identity) {
  await assertOwnedDirectory(directoryPath, identity, 'migration operation root');
  const quarantine = path.join(
    path.dirname(directoryPath),
    `.${path.basename(directoryPath)}.cleanup-${process.pid}-${crypto.randomUUID()}`,
  );
  await fsp.rename(directoryPath, quarantine);
  const moved = await lstatOptional(quarantine);
  if (!moved || moved.isSymbolicLink() || !moved.isDirectory() || !sameIdentity(moved, identity)) {
    throw memorySourceError('invalid_memory_source', 'migration cleanup quarantine identity changed', {
      retryable: false,
    });
  }
  if (await lstatOptional(directoryPath)) {
    throw memorySourceError('invalid_memory_source', 'migration operation pathname turned over', {
      retryable: false,
    });
  }
  await fsp.rm(quarantine, { recursive: true, force: false });
}

async function assertOwnedRegularFile(filePath, identity, label) {
  const stat = await lstatOptional(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(stat, identity)) {
    throw memorySourceError('source_changed', `${label} identity changed`, { retryable: true });
  }
}

async function hashOwnedRegularFile(filePath, identity, expectedBytes, label) {
  const handle = await fsp.open(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(before, identity)
        || Number(before.size) !== expectedBytes) {
      throw memorySourceError('source_changed', `${label} changed before final digest`, {
        retryable: true,
      });
    }
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) {
        throw memorySourceError('source_changed', `${label} truncated during final digest`, {
          retryable: true,
        });
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameIdentity(after, identity)
        || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      throw memorySourceError('source_changed', `${label} changed during final digest`, {
        retryable: true,
      });
    }
  } finally {
    await handle.close();
  }
  await assertOwnedRegularFile(filePath, identity, label);
  return hash.digest('hex');
}

async function removeOwnedRegularFile(filePath, identity) {
  if (!identity) return;
  const stat = await lstatOptional(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(stat, identity)) return;
  await fsp.rm(filePath, { force: false });
}

async function readProjectionIntegrity(projection) {
  const encoded = await readConfinedFile(
    projection.projectionRoot,
    path.join(projection.projectionRoot, 'projection-integrity.json'),
    { maxBytes: MAX_PROJECTION_INTEGRITY_BYTES },
  );
  let integrity;
  try {
    integrity = JSON.parse(encoded.toString('utf8'));
  } catch (cause) {
    throw memorySourceError('invalid_memory_source', 'projection integrity is invalid', {
      retryable: false,
      cause,
    });
  }
  for (const [kind, entry] of Object.entries({
    nodes: projection.manifest.activeBase.nodes,
    edges: projection.manifest.activeBase.edges,
  })) {
    const expected = integrity?.files?.[kind];
    if (!expected || expected.file !== entry.file || expected.count !== entry.count
        || expected.bytes !== entry.bytes || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) {
      throw memorySourceError('invalid_memory_source', 'projection integrity disagrees with manifest', {
        retryable: false,
      });
    }
  }
  return integrity;
}

async function copyProjectionFile({ projectionRoot, sourceFile, brainDir, targetFile, expectedBytes, signal }) {
  const source = await openConfinedRegularFile(
    projectionRoot,
    path.join(projectionRoot, sourceFile),
    { flags: fs.constants.O_RDONLY, signal },
  );
  let target = null;
  try {
    if (Number(source.stat.size) !== expectedBytes) {
      throw memorySourceError('source_changed', 'projection size changed before migration copy', {
        retryable: true,
      });
    }
    target = await fsp.open(
      path.join(brainDir, targetFile),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    const sha256 = crypto.createHash('sha256');
    let position = 0;
    while (position < expectedBytes) {
      throwIfAborted(signal);
      const length = Math.min(buffer.length, expectedBytes - position);
      const result = await source.handle.read(buffer, 0, length, position);
      if (result.bytesRead <= 0) {
        throw memorySourceError('source_changed', 'projection truncated during migration copy', {
          retryable: true,
        });
      }
      sha256.update(buffer.subarray(0, result.bytesRead));
      await writeAll(target, buffer, result.bytesRead, position);
      position += result.bytesRead;
    }
    await target.sync();
    const targetStat = await target.stat({ bigint: true });
    if (Number(targetStat.size) !== expectedBytes) {
      throw memorySourceError('source_changed', 'migration target size mismatch', { retryable: true });
    }
    await assertStableOpenedFileContent(source);
    await assertOpenedFilePathIdentity(source, portableFileIdentity(source.stat));
    return {
      bytes: expectedBytes,
      sha256: sha256.digest('hex'),
      identity: directoryIdentity(targetStat),
    };
  } finally {
    await target?.close().catch(() => {});
    await source?.handle.close().catch(() => {});
  }
}

function existingResult(manifest) {
  return Object.freeze({
    migrated: false,
    authority: 'manifest-v1',
    generation: manifest.generation,
    revision: manifest.currentRevision,
    summary: manifest.summary,
    sourceFingerprint: null,
    files: Object.freeze({
      nodes: manifest.activeBase.nodes.file,
      edges: manifest.activeBase.edges.file,
      delta: manifest.activeDelta.file,
    }),
    unchangedLegacy: true,
  });
}

async function migrateLegacyResidentToManifest({
  brainDir,
  home23Root,
  requesterAgent,
  operationId = `legacy-migration-${crypto.randomUUID()}`,
  signal,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  statfsImpl = fsp.statfs,
  deviceImpl = defaultDeviceImpl,
  lockTimeoutMs = 30 * 60 * 1000,
  _testHooks = {},
} = {}) {
  if (!path.isAbsolute(brainDir || '') || !path.isAbsolute(home23Root || '')
      || !validSegment(requesterAgent) || !validSegment(operationId)
      || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0
      || typeof statfsImpl !== 'function' || typeof deviceImpl !== 'function') {
    throw memorySourceError('invalid_request', 'valid legacy migration options required');
  }
  throwIfAborted(signal);
  const canonicalHome = await fsp.realpath(home23Root);
  const canonicalBrain = await fsp.realpath(brainDir);
  const expectedBrain = await fsp.realpath(path.join(
    canonicalHome,
    'instances',
    requesterAgent,
    'brain',
  )).catch(() => null);
  if (expectedBrain !== canonicalBrain) {
    throw memorySourceError('invalid_request', 'brain does not match requester installation identity', {
      retryable: false,
    });
  }
  const lockRoot = path.join(canonicalHome, 'runtime', 'brain-source-locks');
  const operationRoot = path.join(
    canonicalHome,
    'instances',
    requesterAgent,
    'runtime',
    'brain-operations',
    operationId,
  );
  const preexisting = await readManifest(canonicalBrain);
  if (preexisting) return existingResult(preexisting);

  const operationsRoot = path.dirname(operationRoot);
  await fsp.mkdir(operationsRoot, { recursive: true, mode: 0o700 });
  let operationIdentity;
  try {
    await fsp.mkdir(operationRoot, { recursive: false, mode: 0o700 });
    const operationStat = await fsp.lstat(operationRoot, { bigint: true });
    if (!operationStat.isDirectory() || operationStat.isSymbolicLink()) {
      throw memorySourceError('invalid_memory_source', 'migration operation root is unsafe', {
        retryable: false,
      });
    }
    operationIdentity = directoryIdentity(operationStat);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw memorySourceError('operation_exists', 'migration operation root already exists', {
        retryable: false,
      });
    }
    throw error;
  }
  let result;
  let operationError = null;
  try {
    result = await withMemorySourceLock(canonicalBrain, {
      lockRoot,
      signal,
      lockTimeoutMs,
    }, async () => {
      throwIfAborted(signal);
      const winner = await readManifest(canonicalBrain);
      if (winner) return existingResult(winner);
      const selection = await resolveMemorySourceSelection(canonicalBrain);
      if (selection.authority !== 'legacy-resident-sidecars') {
        throw memorySourceError('source_unavailable', 'legacy resident sidecars are required', {
          retryable: false,
        });
      }

      const legacyBytes = await sumLegacyInputBytes(selection);
      const reserve = BigInt(minFreeBytes);
      const capacity = await assertLegacyMigrationPreflightCapacity({
        brainDir: canonicalBrain,
        scratchDir: operationRoot,
        sourceBytes: legacyBytes,
        minFreeBytes,
        statfsImpl,
        deviceImpl,
      });

      const projection = await projectLegacyResidentSidecars({
        canonicalRoot: canonicalBrain,
        operationRoot,
        signal,
      });
      await assertOwnedDirectory(operationRoot, operationIdentity, 'migration operation root');
      throwIfAborted(signal);
      const projectionIntegrity = await readProjectionIntegrity(projection);
      const projectedBytes = BigInt(projection.manifest.activeBase.nodes.bytes)
        + BigInt(projection.manifest.activeBase.edges.bytes);
      const afterProjectionAvailable = availableBytes(await statfsImpl(canonicalBrain, { bigint: true }));
      assertCapacity({
        available: afterProjectionAvailable,
        required: reserve + projectedBytes,
        phase: 'publication',
        capacityDomain: 'target',
      });
      if (!capacity.sharedFilesystem) {
        const scratchAvailable = availableBytes(await statfsImpl(operationRoot, { bigint: true }));
        assertCapacity({
          available: scratchAvailable,
          required: reserve,
          phase: 'publication',
          capacityDomain: 'scratch',
        });
      }

      const revision = projection.manifest.currentRevision;
      const generation = `g-${revision}-${crypto.randomUUID()}`;
      const epoch = `e-${revision + 1}-${crypto.randomUUID()}`;
      const nodeFile = `memory-nodes.base-${revision}-${crypto.randomUUID()}.jsonl.gz`;
      const edgeFile = `memory-edges.base-${revision}-${crypto.randomUUID()}.jsonl.gz`;
      const deltaFile = `memory-delta.${epoch}.jsonl`;
      const created = [nodeFile, edgeFile, deltaFile];
      const createdIdentities = new Map();
      let published = false;
      try {
        const copiedNodes = await copyProjectionFile({
          projectionRoot: projection.projectionRoot,
          sourceFile: projection.manifest.activeBase.nodes.file,
          brainDir: canonicalBrain,
          targetFile: nodeFile,
          expectedBytes: projection.manifest.activeBase.nodes.bytes,
          signal,
        });
        createdIdentities.set(nodeFile, copiedNodes.identity);
        if (copiedNodes.sha256 !== projectionIntegrity.files.nodes.sha256) {
          throw memorySourceError('source_changed', 'projected node digest changed during migration', {
            retryable: true,
          });
        }
        await _testHooks.afterNodeCopy?.({
          projectionRoot: projection.projectionRoot,
          projectionManifest: projection.manifest,
          targetFiles: { nodes: nodeFile, edges: edgeFile, delta: deltaFile },
        });
        const copiedEdges = await copyProjectionFile({
          projectionRoot: projection.projectionRoot,
          sourceFile: projection.manifest.activeBase.edges.file,
          brainDir: canonicalBrain,
          targetFile: edgeFile,
          expectedBytes: projection.manifest.activeBase.edges.bytes,
          signal,
        });
        createdIdentities.set(edgeFile, copiedEdges.identity);
        if (copiedEdges.sha256 !== projectionIntegrity.files.edges.sha256) {
          throw memorySourceError('source_changed', 'projected edge digest changed during migration', {
            retryable: true,
          });
        }
        await _testHooks.afterEdgeCopy?.({
          projectionRoot: projection.projectionRoot,
          projectionManifest: projection.manifest,
          targetFiles: { nodes: nodeFile, edges: edgeFile, delta: deltaFile },
        });
        const deltaHandle = await fsp.open(
          path.join(canonicalBrain, deltaFile),
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        let deltaIdentity;
        try {
          await deltaHandle.sync();
          deltaIdentity = directoryIdentity(await deltaHandle.stat({ bigint: true }));
        } finally { await deltaHandle.close(); }
        createdIdentities.set(deltaFile, deltaIdentity);
        await fsyncDirectory(canonicalBrain);
        await _testHooks.afterDeltaFsync?.({
          projectionRoot: projection.projectionRoot,
          projectionManifest: projection.manifest,
          targetFiles: { nodes: nodeFile, edges: edgeFile, delta: deltaFile },
        });
        throwIfAborted(signal);
        await assertOwnedDirectory(operationRoot, operationIdentity, 'migration operation root');
        for (const name of created) {
          await assertOwnedRegularFile(
            path.join(canonicalBrain, name),
            createdIdentities.get(name),
            `migration target ${name}`,
          );
        }
        await _testHooks.beforeManifestRename?.({
          projectionRoot: projection.projectionRoot,
          projectionManifest: projection.manifest,
          targetFiles: { nodes: nodeFile, edges: edgeFile, delta: deltaFile },
        });
        throwIfAborted(signal);
        await assertOwnedDirectory(operationRoot, operationIdentity, 'migration operation root');
        const finalNodeDigest = await hashOwnedRegularFile(
          path.join(canonicalBrain, nodeFile),
          createdIdentities.get(nodeFile),
          projection.manifest.activeBase.nodes.bytes,
          'migration node target',
        );
        const finalEdgeDigest = await hashOwnedRegularFile(
          path.join(canonicalBrain, edgeFile),
          createdIdentities.get(edgeFile),
          projection.manifest.activeBase.edges.bytes,
          'migration edge target',
        );
        if (finalNodeDigest !== projectionIntegrity.files.nodes.sha256
            || finalEdgeDigest !== projectionIntegrity.files.edges.sha256) {
          throw memorySourceError('source_changed', 'migration target digest changed before publish', {
            retryable: true,
          });
        }
        if (await readManifest(canonicalBrain)) {
          throw memorySourceError('source_changed', 'memory authority changed during migration', {
            retryable: true,
          });
        }
        const manifest = {
          formatVersion: 1,
          generation,
          baseRevision: revision,
          currentRevision: revision,
          activeDeltaEpoch: epoch,
          activeBase: {
            nodes: { ...projection.manifest.activeBase.nodes, file: nodeFile },
            edges: { ...projection.manifest.activeBase.edges, file: edgeFile },
          },
          activeDelta: {
            epoch,
            file: deltaFile,
            fromRevision: revision + 1,
            toRevision: revision,
            count: 0,
            committedBytes: 0,
          },
          ann: { indexFile: null, metaFile: null, builtFromRevision: null },
          summary: projection.manifest.summary,
        };
        await writeManifestAtomic(canonicalBrain, manifest);
        published = true;
        return Object.freeze({
          migrated: true,
          authority: 'manifest-v1',
          generation,
          revision,
          summary: manifest.summary,
          sourceFingerprint: projection.sourceFingerprint,
          files: Object.freeze({ nodes: nodeFile, edges: edgeFile, delta: deltaFile }),
          unchangedLegacy: true,
        });
      } finally {
        if (!published) {
          await Promise.all(created.map((name) => removeOwnedRegularFile(
            path.join(canonicalBrain, name),
            createdIdentities.get(name),
          ).catch(() => {})));
        }
      }
    });
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  try {
    await removeOwnedDirectory(operationRoot, operationIdentity);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError) {
    if (cleanupError) operationError.cleanupError = cleanupError;
    throw operationError;
  }
  if (cleanupError) {
    return Object.freeze({ ...result, operationCleanup: 'deferred' });
  }
  return result;
}

module.exports = {
  DEFAULT_MIN_FREE_BYTES,
  assertLegacyMigrationPreflightCapacity,
  migrateLegacyResidentToManifest,
};
