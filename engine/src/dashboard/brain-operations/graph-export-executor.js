'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { promises: fsp } = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const {
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
} = require('./operation-contract.js');

const PROGRESS_RECORD_INTERVAL = 10_000;
const PROGRESS_BYTE_INTERVAL = 8 * 1024 * 1024;
const {
  durableBrainOperationRoot,
  enrichEvidenceIdentity,
  memorySourceError,
  throwIfAborted,
} = require('../../../../shared/memory-source');

const FORBIDDEN_PARAMETERS = new Set([
  'outputPath', 'resultPath', 'scratchDir', 'requester', 'requesterAgent',
  'operation', 'operationId', 'root', 'canonicalRoot', 'identity', 'target',
  'resultArtifact', 'sourceEvidence', 'evidence',
]);

function assertNoForbiddenParameters(parameters = {}) {
  for (const key of Object.keys(parameters)) {
    if (FORBIDDEN_PARAMETERS.has(key)) {
      throw memorySourceError('invalid_request', 'caller-controlled export path/evidence is forbidden');
    }
  }
  if (parameters.format !== undefined && parameters.format !== 'jsonl') {
    throw memorySourceError('invalid_request', 'graph export supports only jsonl');
  }
}

function assertExactPinnedSource(context) {
  const sourcePin = context.sourcePin;
  const descriptor = sourcePin?.descriptor;
  if (!sourcePin
      || !descriptor
      || descriptor.canonicalRoot !== context.target?.canonicalRoot
      || !Number.isSafeInteger(descriptor.cutoffRevision)
      || descriptor.cutoffRevision < 0
      || !Number.isSafeInteger(sourcePin.revision)
      || sourcePin.revision !== descriptor.cutoffRevision
      || typeof sourcePin.getEvidence !== 'function'
      || typeof sourcePin.iterateNodes !== 'function'
      || typeof sourcePin.iterateEdges !== 'function') {
    throw memorySourceError('source_changed', 'source pin does not match target revision', {
      retryable: true,
    });
  }
}

async function writeLine(stream, line, signal) {
  throwIfAborted(signal);
  if (stream.write(line)) return;
  await once(stream, 'drain');
  throwIfAborted(signal);
}

async function waitForOpen(stream) {
  if (stream.fd !== null) return;
  await Promise.race([
    once(stream, 'open'),
    once(stream, 'error').then(([error]) => { throw error; }),
  ]);
}

async function destroyAndWait(stream) {
  if (!stream || stream.destroyed) return;
  const closed = once(stream, 'close').catch(() => {});
  stream.destroy();
  await closed;
}

function directoryIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameDirectoryIdentity(stat, expected) {
  return Boolean(expected && stat.dev === expected.dev && stat.ino === expected.ino);
}

function graphPathError(message = 'graph export scratch path is not operation-owned', cause) {
  return memorySourceError('invalid_request', message, { retryable: false, cause });
}

function assertDirectoryOpenSupport() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)
      || !Number.isInteger(fs.constants.O_DIRECTORY)) {
    throw graphPathError('graph export requires no-follow directory operations');
  }
}

async function captureDirectory(directoryPath) {
  let stat;
  let canonical;
  let fd = null;
  try {
    [stat, canonical] = await Promise.all([
      fsp.lstat(directoryPath, { bigint: true }),
      fsp.realpath(directoryPath),
    ]);
  } catch (cause) {
    throw graphPathError(undefined, cause);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directoryPath) {
    throw graphPathError();
  }
  try {
    fd = fs.openSync(
      directoryPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameDirectoryIdentity(opened, directoryIdentity(stat))) {
      throw graphPathError('graph export scratch directory changed while opening');
    }
  } catch (cause) {
    if (fd !== null) fs.closeSync(fd);
    if (cause?.code === 'invalid_request') throw cause;
    throw graphPathError('graph export scratch directory cannot be opened safely', cause);
  }
  return Object.freeze({ path: directoryPath, identity: directoryIdentity(stat), fd });
}

async function verifyDirectories(directories) {
  for (const directory of directories) {
    let stat;
    try {
      stat = await fsp.lstat(directory.path, { bigint: true });
    } catch (cause) {
      throw graphPathError(undefined, cause);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || !sameDirectoryIdentity(stat, directory.identity)) {
      throw graphPathError('graph export scratch directory identity changed');
    }
    let opened;
    try {
      opened = fs.fstatSync(directory.fd, { bigint: true });
    } catch (cause) {
      throw graphPathError('graph export scratch directory anchor changed', cause);
    }
    if (!opened.isDirectory() || !sameDirectoryIdentity(opened, directory.identity)) {
      throw graphPathError('graph export scratch directory anchor changed');
    }
  }
}

function closeDirectories(directories = []) {
  for (const directory of [...directories].reverse()) {
    if (directory.fd === null) continue;
    try { fs.closeSync(directory.fd); } catch {}
  }
}

async function ensureChildDirectory(parent, childPath) {
  await verifyDirectories([parent]);
  try {
    await fsp.mkdir(childPath, { recursive: false, mode: 0o700 });
    fs.fsyncSync(parent.fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw graphPathError(undefined, error);
  }
  await verifyDirectories([parent]);
  return captureDirectory(childPath);
}

async function trustedScratch(context, home23Root) {
  assertDirectoryOpenSupport();
  let scratchDir;
  try {
    scratchDir = await fsp.realpath(context.scratchDir);
  } catch (cause) {
    throw graphPathError(undefined, cause);
  }
  const directories = [];
  try {
    if (home23Root) {
      const root = await fsp.realpath(home23Root);
      const segments = [
        'instances', context.requesterAgent, 'runtime', 'brain-operations',
        'operations', context.operationId, 'scratch',
      ];
      const expected = path.join(
        durableBrainOperationRoot(root, context.requesterAgent, context.operationId), 'scratch',
      );
      if (scratchDir !== expected) throw graphPathError();
      directories.push(await captureDirectory(root));
      let current = root;
      for (const segment of segments) {
        current = path.join(current, segment);
        directories.push(await captureDirectory(current));
      }
    } else {
      directories.push(await captureDirectory(scratchDir));
    }
    await verifyDirectories(directories);
    const results = await ensureChildDirectory(directories.at(-1), path.join(scratchDir, 'results'));
    directories.push(results);
    await verifyDirectories(directories);
    return Object.freeze({ scratchDir, resultsDir: results.path, directories });
  } catch (error) {
    closeDirectories(directories);
    throw error;
  }
}

function fileIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

async function assertExactFile(filePath, expected, directories, { links = 1n } = {}) {
  await verifyDirectories(directories);
  let stat;
  try {
    stat = await fsp.lstat(filePath, { bigint: true });
  } catch (cause) {
    throw graphPathError('graph export artifact identity changed', cause);
  }
  if (!stat.isFile() || stat.isSymbolicLink()
      || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.nlink !== links) {
    throw graphPathError('graph export artifact identity changed');
  }
  return stat;
}

async function assertPathAbsent(filePath, directories, message) {
  await verifyDirectories(directories);
  try {
    await fsp.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw graphPathError(message, error);
  }
  throw graphPathError(message);
}

async function verifyPublishedFile(filePath, expected, directories, bytes) {
  await assertExactFile(filePath, expected, directories);
  let fd = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
        || opened.dev !== expected.dev || opened.ino !== expected.ino
        || opened.size !== BigInt(bytes)) {
      throw graphPathError('graph export artifact readback changed');
    }
  } catch (cause) {
    if (cause?.code === 'invalid_request') throw cause;
    throw graphPathError('graph export artifact cannot be read back safely', cause);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  await assertExactFile(filePath, expected, directories);
}

async function removeExactFile(filePath, expected, directories) {
  if (!expected) return false;
  await verifyDirectories(directories);
  let stat;
  try {
    stat = await fsp.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw graphPathError('graph export artifact cleanup failed', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()
      || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw graphPathError('graph export artifact cleanup identity changed');
  }
  await fsp.unlink(filePath);
  await verifyDirectories(directories);
  return true;
}

async function claimScratch(context, bytes, usedBytes) {
  if (usedBytes + bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES) {
    throw memorySourceError('result_too_large', 'graph export artifact exceeds result budget', {
      status: 413,
      retryable: false,
    });
  }
  await context.scratchQuota?.claim?.(bytes, 'graph_export');
  return usedBytes + bytes;
}

function createGraphExportExecutor({ home23Root } = {}) {
  return async function graphExportExecutor(context) {
    throwIfAborted(context.signal);
    assertNoForbiddenParameters(context.parameters || {});
    assertExactPinnedSource(context);
    const scratch = await trustedScratch(context, home23Root);
    const { resultsDir, directories } = scratch;
    const base = path.join(resultsDir, `graph-${context.operationId}.jsonl`);
    const tmp = `${base}.tmp`;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let nodeCount = 0;
    let edgeCount = 0;
    let claimedBytes = 0;
    let handle = null;
    let stream = null;
    let temporaryIdentity = null;
    let finalLinked = false;
    let temporaryRemoved = false;
    let completed = false;
    let nextProgressRecords = PROGRESS_RECORD_INTERVAL;
    let nextProgressBytes = PROGRESS_BYTE_INTERVAL;
    const reportStreamingProgress = () => {
      if (typeof context.reportEvent !== 'function') return;
      const completedRecords = nodeCount + edgeCount;
      if (completedRecords < nextProgressRecords && bytes < nextProgressBytes) return;
      context.reportEvent(Object.freeze({
        type: 'progress',
        phase: 'graph_export',
        stage: 'graph_streaming',
        completedRecords,
        completedBytes: bytes,
      }));
      while (nextProgressRecords <= completedRecords) {
        nextProgressRecords += PROGRESS_RECORD_INTERVAL;
      }
      while (nextProgressBytes <= bytes) nextProgressBytes += PROGRESS_BYTE_INTERVAL;
    };
    try {
      if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
        throw graphPathError('graph export requires no-follow file creation');
      }
      await verifyDirectories(directories);
      await assertPathAbsent(base, directories, 'graph export artifact already exists');
      handle = await fsp.open(
        tmp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) {
        throw graphPathError('graph export artifact is not a private regular file');
      }
      temporaryIdentity = fileIdentity(opened);
      stream = fs.createWriteStream(null, { fd: handle.fd, autoClose: false });
      await waitForOpen(stream);
      for await (const record of context.sourcePin.iterateNodes({ signal: context.signal })) {
        const line = `${JSON.stringify({ type: 'node', record })}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        claimedBytes = await claimScratch(context, size, claimedBytes);
        await writeLine(stream, line, context.signal);
        hash.update(line);
        bytes += size;
        nodeCount += 1;
        reportStreamingProgress();
      }
      for await (const record of context.sourcePin.iterateEdges({ signal: context.signal })) {
        const line = `${JSON.stringify({ type: 'edge', record })}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        claimedBytes = await claimScratch(context, size, claimedBytes);
        await writeLine(stream, line, context.signal);
        hash.update(line);
        bytes += size;
        edgeCount += 1;
        reportStreamingProgress();
      }
      const finished = once(stream, 'finish');
      stream.end();
      await finished;
      await handle.sync();
      await assertExactFile(tmp, temporaryIdentity, directories);
      await handle.close();
      handle = null;
      await destroyAndWait(stream);
      throwIfAborted(context.signal);
      await verifyDirectories(directories);
      await assertPathAbsent(base, directories, 'graph export artifact appeared before publication');
      try {
        await fsp.link(tmp, base);
      } catch (cause) {
        throw graphPathError('graph export artifact publication failed', cause);
      }
      finalLinked = true;
      await assertExactFile(tmp, temporaryIdentity, directories, { links: 2n });
      await assertExactFile(base, temporaryIdentity, directories, { links: 2n });
      await fsp.unlink(tmp);
      temporaryRemoved = true;
      fs.fsyncSync(directories.at(-1).fd);
      await verifyPublishedFile(base, temporaryIdentity, directories, bytes);
      await verifyDirectories(directories);
      completed = true;
      const evidence = {
        ...enrichEvidenceIdentity(context.sourcePin.getEvidence({
        completeCoverage: true,
        authoritativeTotals: { nodes: nodeCount, edges: edgeCount },
        returnedTotals: { nodes: nodeCount, edges: edgeCount },
      }), context.identity),
        graphExport: {
          nodeCount,
          edgeCount,
          sourceRevision: context.sourcePin.revision,
        },
      };
      return {
        result: null,
        evidence,
        resultArtifact: {
          scratchPath: base,
          mediaType: 'application/x-ndjson',
          contentEncoding: 'identity',
          bytes,
          sha256: hash.digest('hex'),
        },
      };
    } finally {
      if (!completed) {
        await destroyAndWait(stream);
        await handle?.close().catch(() => {});
        let cleaned = false;
        try {
          const finalRemoved = !finalLinked
            || await removeExactFile(base, temporaryIdentity, directories);
          const tempRemoved = temporaryRemoved
            || await removeExactFile(tmp, temporaryIdentity, directories);
          fs.fsyncSync(directories.at(-1).fd);
          await verifyDirectories(directories);
          cleaned = finalRemoved && tempRemoved;
        } catch {}
        if (cleaned && claimedBytes > 0) {
          await context.scratchQuota?.release?.(claimedBytes).catch(() => {});
        }
      }
      closeDirectories(directories);
    }
  };
}

module.exports = { createGraphExportExecutor };
