'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const {
  isTypedMemorySourceError,
  rethrowAbort,
  throwIfAborted,
  memorySourceError,
} = require('./contracts.cjs');
const {
  openConfinedRegularFile,
  assertStableOpenedFile,
  assertStableOpenedFileContent,
  assertStableOpenedFilePrefix,
} = require('./confined-file.cjs');
const { getOperationScratchQuotaCleanup } = require('./scratch-quota.cjs');
const { OPENED_JSONL_FILE } = require('./private-capabilities.cjs');

function limitError(limitKind, limit) {
  return memorySourceError('result_too_large', `memory source ${limitKind} limit exceeded`, {
    status: 413,
    retryable: false,
    limitKind,
    limit,
  });
}

function validatePositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw memorySourceError('invalid_request', `invalid ${name}`);
  }
}

const DEFAULT_GZIP_RESERVATION_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_GZIP_RESERVATION_WINDOW_BYTES = 64 * 1024 * 1024;
const DEFAULT_GZIP_CHUNK_BYTES = 64 * 1024;
const MAX_GZIP_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_WRITES = 64;
const DEFAULT_MAX_PENDING_BYTES = 32 * 1024 * 1024;

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(stat, identity) {
  return Boolean(stat && identity && stat.dev === identity.dev && stat.ino === identity.ino);
}

async function lstatOptional(filePath) {
  return fsp.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isInsideOrSame(root, candidate) {
  return candidate === root || isInside(root, candidate);
}

function confinementError(message, cause) {
  return memorySourceError('invalid_memory_source', message, {
    retryable: false,
    ...(cause ? { cause } : {}),
  });
}

function sourceWriteError(message, cause) {
  return memorySourceError('source_unavailable', message, {
    retryable: true,
    ...(cause ? { cause } : {}),
  });
}

function pendingWriteError(limitKind, limit) {
  return memorySourceError('source_busy', `gzip writer ${limitKind} limit exceeded`, {
    status: 409,
    retryable: true,
    limitKind,
    limit,
  });
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateGzipWriterOptions(options) {
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;
  const reservationWindowBytes = options.reservationWindowBytes
    ?? DEFAULT_GZIP_RESERVATION_WINDOW_BYTES;
  const gzipChunkBytes = options.gzipChunkBytes ?? DEFAULT_GZIP_CHUNK_BYTES;
  const maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  const level = options.level ?? zlib.constants.Z_BEST_SPEED;
  validatePositiveLimit(maxRecordBytes, 'record limit');
  validatePositiveLimit(reservationWindowBytes, 'reservation window');
  validatePositiveLimit(gzipChunkBytes, 'gzip chunk size');
  validatePositiveLimit(maxPendingWrites, 'pending write count');
  validatePositiveLimit(maxPendingBytes, 'pending write bytes');
  if (reservationWindowBytes > MAX_GZIP_RESERVATION_WINDOW_BYTES
      || reservationWindowBytes * 2 > Number.MAX_SAFE_INTEGER) {
    throw memorySourceError('invalid_request', 'invalid reservation window');
  }
  if (gzipChunkBytes < zlib.constants.Z_MIN_CHUNK
      || gzipChunkBytes > MAX_GZIP_CHUNK_BYTES) {
    throw memorySourceError('invalid_request', 'invalid gzip chunk size');
  }
  if (!Number.isInteger(level) || level < zlib.constants.Z_DEFAULT_COMPRESSION
      || level > zlib.constants.Z_BEST_COMPRESSION) {
    throw memorySourceError('invalid_request', 'invalid gzip compression level');
  }
  const hooks = options._testHooks || {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || Object.values(hooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid gzip writer test hooks');
  }
  return {
    maxRecordBytes,
    reservationWindowBytes,
    gzipChunkBytes,
    maxPendingWrites,
    maxPendingBytes,
    level,
    hooks,
  };
}

/**
 * Create a bounded, quota-aware JSONL gzip writer inside an operation scratch
 * root. Compressed bytes are written through an inode-anchored file handle;
 * the pathname is used only after its exact identity has been revalidated.
 *
 * Compressed growth is materialized while the aggregate quota owns its exact
 * root lock. That makes physical growth and quota reconciliation one serialized
 * boundary across concurrent writers instead of exposing a release/write gap.
 */
async function createQuotaBackpressuredJsonlGzipWriter(filePath, options = {}) {
  throwIfAborted(options.signal);
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw confinementError('O_NOFOLLOW unavailable');
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || filePath.includes('\0') || path.normalize(filePath) !== filePath) {
    throw memorySourceError('invalid_request', 'canonical projection output path required');
  }
  if (typeof options.operationRoot !== 'string' || !path.isAbsolute(options.operationRoot)
      || !options.scratchQuota
      || typeof options.scratchQuota.assertOperationRoot !== 'function'
      || typeof options.scratchQuota.claim !== 'function'
      || typeof options.scratchQuota.release !== 'function'
      || typeof options.scratchQuota.reconcile !== 'function'
      || typeof options.scratchQuota.withPhysicalGrowth !== 'function') {
    throw memorySourceError('source_operation_required', 'operation scratch quota required');
  }
  const {
    maxRecordBytes,
    reservationWindowBytes,
    gzipChunkBytes,
    maxPendingWrites,
    maxPendingBytes,
    level,
    hooks,
  } = validateGzipWriterOptions(options);
  if (await options.scratchQuota.assertOperationRoot(options.operationRoot) !== true) {
    throw memorySourceError('source_operation_required', 'exact operation scratch quota required');
  }
  const operationRoot = options.scratchQuota.operationRoot;
  if (operationRoot !== options.operationRoot || !isInside(operationRoot, filePath)) {
    throw memorySourceError('invalid_request', 'projection output must be inside operation scratch');
  }
  const parentPath = path.dirname(filePath);
  let parentStat;
  let parentReal;
  try {
    [parentStat, parentReal] = await Promise.all([
      fsp.lstat(parentPath),
      fsp.realpath(parentPath),
    ]);
  } catch (error) {
    throw confinementError('projection output directory is unavailable', error);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || parentReal !== parentPath
      || !isInsideOrSame(operationRoot, parentReal)) {
    throw confinementError('projection output directory is not operation-private');
  }
  const parentIdentity = identityOf(parentStat);
  if (await lstatOptional(filePath) !== null) {
    throw confinementError('projection output already exists');
  }

  const scratchQuota = options.scratchQuota;
  let cleanupQuota = scratchQuota;
  try {
    cleanupQuota = getOperationScratchQuotaCleanup(scratchQuota);
  } catch (error) {
    // Compatibility/test wrappers still use the normal authority. Exact
    // operation-quota handles receive the abort-independent cleanup capability.
    if (error?.code !== 'invalid_request') throw error;
  }
  const quotaKind = `memory_projection_gzip_${crypto.randomUUID()}`;
  const tempPath = path.join(
    parentPath,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let tempHandle = null;
  let tempIdentity = null;
  let tempRemoved = false;
  let finalLinked = false;
  let finalRemoved = false;
  let state = 'initializing';
  let failure = null;
  let outputFailure = null;
  let compressedBytes = 0;
  let recordCount = 0;
  let digest = null;
  let cleanupComplete = false;
  let cleanupPromise = null;
  let finishPromise = null;
  let mutationTail = Promise.resolve();
  let pendingWrites = 0;
  let pendingBytes = 0;
  const hash = crypto.createHash('sha256');

  async function assertParentStable(quotaAuthority = scratchQuota) {
    await quotaAuthority.assertOperationRoot(operationRoot);
    let stat;
    let canonical;
    try {
      [stat, canonical] = await Promise.all([
        fsp.lstat(parentPath),
        fsp.realpath(parentPath),
      ]);
    } catch (error) {
      throw confinementError('projection output directory became unavailable', error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || !sameIdentity(stat, parentIdentity) || canonical !== parentPath) {
      throw confinementError('projection output directory identity changed');
    }
    await quotaAuthority.assertOperationRoot(operationRoot);
  }

  async function assertOwnedPathStable(candidatePath, {
    requireHandle = false,
    expectedLinks = 1,
  } = {}) {
    await assertParentStable();
    let stat;
    try {
      stat = await fsp.lstat(candidatePath);
    } catch (error) {
      throw confinementError('projection output artifact became unavailable', error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(stat, tempIdentity)
        || stat.nlink !== expectedLinks) {
      throw confinementError('projection output artifact identity changed');
    }
    if (requireHandle) {
      let anchored;
      try {
        anchored = await tempHandle.stat();
      } catch (error) {
        throw confinementError('projection output anchor became unavailable', error);
      }
      if (!anchored.isFile() || !sameIdentity(anchored, tempIdentity)
          || anchored.nlink !== expectedLinks) {
        throw confinementError('projection output anchor identity changed');
      }
    }
    await assertParentStable();
    return stat;
  }

  function abortReason() {
    return options.signal?.reason || Object.assign(new Error('cancelled'), {
      name: 'AbortError',
      code: 'cancelled',
    });
  }

  let gzip;
  function rememberFailure(error) {
    if (!failure) failure = error;
    if (state !== 'finished' && state !== 'cleaned') state = 'failed';
    if (gzip && !gzip.destroyed) gzip.destroy(error instanceof Error ? error : undefined);
    return failure;
  }

  async function writeCompressedSliceBody(slice, checkpoint) {
    const sliceLength = slice.length;
    await hooks.beforeCompressedWrite?.({
      filePath,
      tempPath,
      bytes: sliceLength,
      offset: compressedBytes,
    });
    throwIfAborted(options.signal);
    const before = await assertOwnedPathStable(tempPath, { requireHandle: true });
    if (Number(before.size) !== compressedBytes) {
      throw confinementError('projection output size changed before write');
    }
    let offset = 0;
    while (offset < slice.length) {
      throwIfAborted(options.signal);
      let written;
      try {
        ({ bytesWritten: written } = await tempHandle.write(
          slice,
          offset,
          slice.length - offset,
          compressedBytes,
        ));
      } catch (error) {
        throw sourceWriteError('compressed projection output write failed', error);
      }
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw sourceWriteError('compressed projection output made no write progress');
      }
      hash.update(slice.subarray(offset, offset + written));
      offset += written;
      compressedBytes += written;
      if (!Number.isSafeInteger(compressedBytes)) {
        throw limitError('compressed', Number.MAX_SAFE_INTEGER);
      }
    }
    const after = await assertOwnedPathStable(tempPath, { requireHandle: true });
    if (Number(after.size) !== compressedBytes) {
      throw confinementError('projection output size changed after write');
    }
    await checkpoint?.();
    await hooks.afterCompressedWrite?.({
      filePath,
      tempPath,
      bytes: sliceLength,
      offset: compressedBytes,
    });
    return sliceLength;
  }

  async function writeCompressedSlice(buffer) {
    const requestedBytes = Math.min(buffer.length, reservationWindowBytes);
    const slice = buffer.subarray(0, requestedBytes);
    return scratchQuota.withPhysicalGrowth(
      slice.length,
      quotaKind,
      ({ checkpoint }) => writeCompressedSliceBody(slice, checkpoint),
    );
  }

  async function consumeCompressedOutput() {
    let pendingChunks = [];
    let pendingBytes = 0;

    function takePending(bytes) {
      const joined = pendingChunks.length === 1
        ? pendingChunks[0]
        : Buffer.concat(pendingChunks, pendingBytes);
      const ready = joined.subarray(0, bytes);
      const remainder = joined.subarray(bytes);
      pendingChunks = remainder.length > 0 ? [remainder] : [];
      pendingBytes -= ready.length;
      return ready;
    }

    async function flushPending(bytes) {
      const ready = takePending(bytes);
      let offset = 0;
      while (offset < ready.length) {
        try {
          offset += await writeCompressedSlice(ready.subarray(offset));
        } catch (error) {
          // Node's Readable async iterator can replace an error thrown by the
          // loop body with its own teardown AbortError. Capture the
          // authoritative failure before iterator return/destroy runs.
          outputFailure = isTypedMemorySourceError(error)
            ? error
            : sourceWriteError('compressed projection stream failed', error);
          throw error;
        }
      }
    }

    try {
      for await (const chunk of gzip) {
        throwIfAborted(options.signal);
        pendingChunks.push(chunk);
        pendingBytes += chunk.length;
        if (!Number.isSafeInteger(pendingBytes)
            || pendingBytes > reservationWindowBytes + gzipChunkBytes) {
          throw limitError('compressed_pending', reservationWindowBytes + gzipChunkBytes);
        }
        while (pendingBytes >= reservationWindowBytes) {
          await flushPending(reservationWindowBytes);
        }
      }
      if (pendingBytes > 0) await flushPending(pendingBytes);
      throwIfAborted(options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        const reason = abortReason();
        outputFailure = reason;
        rememberFailure(reason);
        throw reason;
      }
      outputFailure ||= isTypedMemorySourceError(error)
        ? error : sourceWriteError('compressed projection stream failed', error);
      rememberFailure(outputFailure);
      throw outputFailure;
    }
  }

  function waitForDrain() {
    if (outputFailure) return Promise.reject(outputFailure);
    return new Promise((resolve, reject) => {
      function clear() {
        gzip.removeListener('drain', drained);
        gzip.removeListener('error', errored);
        gzip.removeListener('close', closed);
      }
      function drained() {
        clear();
        resolve();
      }
      function errored(error) {
        clear();
        reject(error);
      }
      function closed() {
        clear();
        reject(failure || outputFailure || sourceWriteError('compressed projection stream closed'));
      }
      gzip.once('drain', drained);
      gzip.once('error', errored);
      gzip.once('close', closed);
    });
  }

  function serializeRecord(record) {
    let serialized;
    try {
      serialized = JSON.stringify(record);
    } catch (error) {
      throw sourceWriteError('projection record is not serializable', error);
    }
    if (serialized === undefined) {
      throw sourceWriteError('projection record is not serializable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxRecordBytes) {
      throw limitError('record', maxRecordBytes);
    }
    return Buffer.from(`${serialized}\n`, 'utf8');
  }

  async function writeOne(line) {
    if (failure) throw failure;
    throwIfAborted(options.signal);
    if (!gzip.write(line)) await waitForDrain();
    if (outputFailure) throw outputFailure;
    throwIfAborted(options.signal);
    recordCount += 1;
    await hooks.afterRecordAccepted?.({ count: recordCount });
    throwIfAborted(options.signal);
    return recordCount;
  }

  function enqueueWrite(record) {
    if (state !== 'open') {
      return Promise.reject(failure || memorySourceError('invalid_request', 'gzip writer is not open'));
    }
    if (pendingWrites >= maxPendingWrites) {
      return Promise.reject(pendingWriteError('pending_writes', maxPendingWrites));
    }
    let line;
    try {
      line = serializeRecord(record);
    } catch (error) {
      const normalized = isTypedMemorySourceError(error)
        ? error : sourceWriteError('projection record write failed', error);
      rememberFailure(normalized);
      return Promise.reject(normalized);
    }
    const nextPendingBytes = pendingBytes + line.length;
    if (!Number.isSafeInteger(nextPendingBytes) || nextPendingBytes > maxPendingBytes) {
      return Promise.reject(pendingWriteError('pending_bytes', maxPendingBytes));
    }
    pendingWrites += 1;
    pendingBytes = nextPendingBytes;
    const result = mutationTail.then(() => writeOne(line)).catch((error) => {
      if (options.signal?.aborted) {
        const reason = abortReason();
        rememberFailure(reason);
        throw reason;
      }
      const primary = outputFailure || error;
      const normalized = isTypedMemorySourceError(primary)
        ? primary : sourceWriteError('projection record write failed', primary);
      rememberFailure(normalized);
      throw normalized;
    }).finally(() => {
      pendingWrites -= 1;
      pendingBytes -= line.length;
    });
    mutationTail = result.catch(() => {});
    return result;
  }

  async function removeExactOwnedPath(
    candidatePath,
    alreadyRemoved,
    quotaAuthority = scratchQuota,
  ) {
    if (alreadyRemoved) return true;
    await assertParentStable(quotaAuthority);
    const stat = await lstatOptional(candidatePath);
    if (stat === null || stat.isSymbolicLink() || !stat.isFile()
        || !sameIdentity(stat, tempIdentity)) {
      throw confinementError('projection cleanup artifact identity changed');
    }
    await assertParentStable(quotaAuthority);
    const latest = await fsp.lstat(candidatePath).catch((error) => {
      throw confinementError('projection cleanup artifact became unavailable', error);
    });
    if (latest.isSymbolicLink() || !latest.isFile() || !sameIdentity(latest, tempIdentity)) {
      throw confinementError('projection cleanup artifact changed before removal');
    }
    await fsp.unlink(candidatePath);
    // The owned directory entry is gone even if the post-unlink confinement
    // check fails. Remember that irreversible fact so a retry does not treat
    // the expected ENOENT as identity uncertainty and strand quota forever.
    if (candidatePath === tempPath) tempRemoved = true;
    if (candidatePath === filePath) finalRemoved = true;
    await assertParentStable(quotaAuthority);
    return true;
  }

  async function cleanupInternal() {
    if (cleanupComplete || state === 'finished') return;
    if (!failure) failure = memorySourceError('source_unavailable', 'projection writer cleaned up');
    state = 'failed';
    if (gzip && !gzip.destroyed) gzip.destroy();
    await mutationTail.catch(() => {});
    await outputPromise.catch(() => {});
    if (tempHandle) {
      await tempHandle.close().catch((error) => {
        if (error.code !== 'EBADF') throw error;
      });
      tempHandle = null;
    }
    if (finalLinked && !finalRemoved) {
      finalRemoved = await removeExactOwnedPath(filePath, finalRemoved, cleanupQuota);
    }
    if (!tempRemoved) {
      tempRemoved = await removeExactOwnedPath(tempPath, tempRemoved, cleanupQuota);
    }
    await syncDirectory(parentPath);
    await assertParentStable(cleanupQuota);
    await cleanupQuota.reconcile();
    cleanupComplete = true;
    state = 'cleaned';
    options.signal?.removeEventListener('abort', abort);
  }

  function cleanup() {
    if (cleanupComplete || state === 'finished') return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        await cleanupInternal();
      } finally {
        cleanupPromise = null;
      }
    })();
    return cleanupPromise;
  }

  async function linkFinalPath(checkpoint) {
    await assertParentStable();
    if (await lstatOptional(filePath) !== null) {
      throw confinementError('projection output appeared before publication');
    }
    try {
      await fsp.link(tempPath, filePath);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw confinementError('projection output appeared during publication', error);
      }
      throw sourceWriteError('projection output publication failed', error);
    }
    finalLinked = true;
    await assertOwnedPathStable(filePath, { expectedLinks: 2 });
    await checkpoint?.();
  }

  async function completeFinalPublication() {
    await hooks.afterFinalLinked?.({ filePath, tempPath, bytes: compressedBytes });
    throwIfAborted(options.signal);
    tempRemoved = await removeExactOwnedPath(tempPath, tempRemoved);
    await syncDirectory(parentPath);
    await assertOwnedPathStable(filePath);
  }

  async function finishInternal() {
    try {
      await mutationTail;
      if (failure) throw failure;
      throwIfAborted(options.signal);
      gzip.end();
      await outputPromise;
      if (outputFailure) throw outputFailure;
      throwIfAborted(options.signal);
      await assertOwnedPathStable(tempPath, { requireHandle: true });
      await tempHandle.sync();
      const finalStat = await tempHandle.stat();
      if (!finalStat.isFile() || !sameIdentity(finalStat, tempIdentity)
          || Number(finalStat.size) !== compressedBytes || finalStat.nlink !== 1) {
        throw confinementError('projection output changed before publication');
      }
      await tempHandle.close();
      tempHandle = null;
      await scratchQuota.withPhysicalGrowth(
        compressedBytes,
        quotaKind,
        async ({ checkpoint }) => {
          await linkFinalPath(checkpoint);
          await completeFinalPublication();
        },
      );
      throwIfAborted(options.signal);
      digest = hash.digest('hex');
      state = 'finished';
      options.signal?.removeEventListener('abort', abort);
      return Object.freeze({ count: recordCount, bytes: compressedBytes, sha256: digest });
    } catch (error) {
      const primary = outputFailure || error;
      const normalized = options.signal?.aborted
        ? abortReason()
        : (isTypedMemorySourceError(primary)
          ? primary : sourceWriteError('projection output finalization failed', primary));
      rememberFailure(normalized);
      await cleanup().catch(() => {});
      throw normalized;
    }
  }

  function finish() {
    if (state === 'finished' && finishPromise) return finishPromise;
    if (finishPromise) return finishPromise;
    if (state !== 'open' && state !== 'failed') {
      return Promise.reject(failure || memorySourceError('invalid_request', 'gzip writer cannot finish'));
    }
    state = state === 'failed' ? 'failed' : 'finishing';
    finishPromise = finishInternal();
    return finishPromise;
  }

  async function writeAll(records) {
    if (records === null || records === undefined
        || (typeof records[Symbol.asyncIterator] !== 'function'
          && typeof records[Symbol.iterator] !== 'function')) {
      throw memorySourceError('invalid_request', 'iterable projection records required');
    }
    try {
      for await (const record of records) await enqueueWrite(record);
      return await finish();
    } catch (error) {
      const primary = outputFailure || error;
      const normalized = options.signal?.aborted
        ? abortReason()
        : (isTypedMemorySourceError(primary)
          ? primary : sourceWriteError('projection record stream failed', primary));
      rememberFailure(normalized);
      await cleanup().catch(() => {});
      throw normalized;
    }
  }

  function abort() {
    const reason = abortReason();
    rememberFailure(reason);
  }

  let outputPromise = Promise.resolve();
  try {
    await assertParentStable();
    tempHandle = await fsp.open(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const opened = await tempHandle.stat();
    if (!opened.isFile()) throw confinementError('projection temporary output is not regular');
    tempIdentity = identityOf(opened);
    await assertOwnedPathStable(tempPath, { requireHandle: true });
    gzip = zlib.createGzip({ level, chunkSize: gzipChunkBytes });
    outputPromise = consumeCompressedOutput();
    outputPromise.catch(() => {});
    options.signal?.addEventListener('abort', abort, { once: true });
    await hooks.afterTempCreated?.({ filePath, tempPath });
    throwIfAborted(options.signal);
    state = 'open';
  } catch (error) {
    let normalized;
    try {
      rethrowAbort(error, options.signal);
      normalized = isTypedMemorySourceError(error)
        ? error
        : sourceWriteError('projection writer initialization failed', error);
    } catch (abortError) {
      normalized = abortError;
    }
    rememberFailure(normalized);
    if (tempIdentity) await cleanup().catch(() => {});
    else await tempHandle?.close().catch(() => {});
    throw normalized;
  }

  return Object.freeze({
    write: enqueueWrite,
    writeAll,
    finish,
    cleanup,
    get tempPath() { return tempPath; },
  });
}

async function* readJsonl(filePath, options = {}) {
  throwIfAborted(options.signal);
  const confinedRoot = options.confinedRoot || path.dirname(filePath);
  const borrowed = options[OPENED_JSONL_FILE] !== undefined;
  if (borrowed && (!options[OPENED_JSONL_FILE]
      || options[OPENED_JSONL_FILE].path !== filePath
      || typeof options[OPENED_JSONL_FILE].handle?.stat !== 'function')) {
    throw memorySourceError('invalid_request', 'exact opened JSONL file required');
  }
  const opened = borrowed
    ? options[OPENED_JSONL_FILE]
    : await openConfinedRegularFile(confinedRoot, filePath, {
      flags: fs.constants.O_RDONLY,
      maxBytes: options.maxInputBytes,
      signal: options.signal,
    });
  const closeOpened = async () => {
    if (!borrowed) await opened.handle.close();
  };
  const stat = opened.stat;
  if (options.maxInputBytes !== undefined
      && (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 0
        || Number(stat.size) > options.maxInputBytes)) {
    await closeOpened();
    throw memorySourceError('result_too_large', 'file limit exceeded', {
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: options.maxInputBytes,
    });
  }
  if (options.expectedInputBytes !== undefined
      && (!Number.isSafeInteger(options.expectedInputBytes)
        || options.expectedInputBytes < 0
        || Number(stat.size) !== options.expectedInputBytes)) {
    await closeOpened();
    throw memorySourceError('source_unavailable', 'authoritative JSONL size mismatch', {
      retryable: true,
    });
  }
  const inputBytes = options.byteLimit === undefined ? Number(stat.size) : options.byteLimit;
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
    await closeOpened();
    throw memorySourceError('invalid_request', 'invalid JSONL byte limit');
  }
  if (inputBytes > Number(stat.size)) {
    await closeOpened();
    throw memorySourceError('source_unavailable', 'committed JSONL prefix is truncated', {
      retryable: true,
    });
  }
  const validatePrefix = options.allowTrailingBytes === true
    && options.byteLimit !== undefined
    && options.gzip !== true;
  const prefixHash = validatePrefix ? crypto.createHash('sha256') : null;
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;
  const maxDecompressedBytes = options.maxDecompressedBytes ?? 2 * 1024 * 1024 * 1024;
  validatePositiveLimit(maxRecordBytes, 'record limit');
  validatePositiveLimit(maxDecompressedBytes, 'decompressed limit');
  if (inputBytes === 0) {
    if (prefixHash) {
      await assertStableOpenedFilePrefix(opened, {
        bytes: 0,
        sha256: prefixHash.digest('hex'),
      });
    } else if (borrowed) {
      await assertStableOpenedFileContent(opened);
    } else {
      await assertStableOpenedFile(opened);
    }
    await closeOpened();
    if (options.gzip) {
      throw memorySourceError('source_unavailable', 'gzip base is empty', { retryable: true });
    }
    if (options.expectedRecordCount !== undefined && options.expectedRecordCount !== 0) {
      throw memorySourceError('source_unavailable', 'authoritative JSONL count mismatch', {
        retryable: true,
      });
    }
    return;
  }

  const input = fs.createReadStream(null, {
    fd: opened.handle.fd,
    autoClose: false,
    start: 0,
    end: inputBytes - 1,
  });
  const decoded = options.gzip ? input.pipe(zlib.createGunzip()) : input;
  const abort = () => {
    decoded.destroy();
    input.destroy();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let lineNumber = 0;
  let recordCount = 0;
  let decodedBytes = 0;
  let pending = '';
  let completed = false;
  const decoder = new StringDecoder('utf8');
  const parseLine = (line) => {
    lineNumber += 1;
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch (error) {
      if (options.onParseError) {
        options.onParseError({ error, lineNumber, filePath });
        return null;
      }
      throw memorySourceError('source_unavailable', 'authoritative JSONL record is malformed', {
        cause: error,
        retryable: true,
      });
    }
  };

  try {
    for await (const chunk of decoded) {
      throwIfAborted(options.signal);
      prefixHash?.update(chunk);
      decodedBytes += chunk.length;
      if (decodedBytes > maxDecompressedBytes) {
        throw limitError('decompressed', maxDecompressedBytes);
      }
      pending += decoder.write(chunk);
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > maxRecordBytes) {
          throw limitError('record', maxRecordBytes);
        }
        const record = parseLine(line);
        if (record !== null) {
          recordCount += 1;
          yield record;
          throwIfAborted(options.signal);
        }
      }
      if (Buffer.byteLength(pending, 'utf8') > maxRecordBytes) {
        throw limitError('record', maxRecordBytes);
      }
    }
    pending += decoder.end();
    if (Buffer.byteLength(pending, 'utf8') > maxRecordBytes) {
      throw limitError('record', maxRecordBytes);
    }
    if (options.requireCompletePrefix && pending.length > 0) {
      throw memorySourceError('source_unavailable', 'committed JSONL prefix ends mid-record', {
        retryable: true,
      });
    }
    const tail = pending.replace(/\r$/, '');
    if (tail) {
      const record = parseLine(tail);
      if (record !== null) {
        recordCount += 1;
        yield record;
        throwIfAborted(options.signal);
      }
    }
    if (options.expectedRecordCount !== undefined && recordCount !== options.expectedRecordCount) {
      throw memorySourceError('source_unavailable', 'authoritative JSONL count mismatch', {
        retryable: true,
      });
    }
    if (prefixHash) {
      await assertStableOpenedFilePrefix(opened, {
        bytes: inputBytes,
        sha256: prefixHash.digest('hex'),
      });
    } else if (borrowed) {
      await assertStableOpenedFileContent(opened);
    } else {
      await assertStableOpenedFile(opened);
    }
    completed = true;
  } catch (error) {
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)) throw error;
    throw memorySourceError('source_unavailable', 'authoritative JSONL source is unreadable', {
      cause: error,
      retryable: true,
    });
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (!completed) {
      decoded.destroy();
      input.destroy();
    }
    if (!borrowed) {
      await opened.handle.close().catch((error) => {
        if (error?.code !== 'EBADF') throw error;
      });
    }
  }
}

async function writeJsonlGzAtomic(filePath, records, options = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const gzip = zlib.createGzip({ level: options.level ?? zlib.constants.Z_BEST_SPEED });
  const output = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 });
  const abort = () => {
    const reason = options.signal.reason || Object.assign(new Error('cancelled'), {
      name: 'AbortError',
      code: 'cancelled',
    });
    gzip.destroy(reason);
    output.destroy(reason);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  gzip.pipe(output);
  let count = 0;
  try {
    for await (const record of records) {
      throwIfAborted(options.signal);
      const serialized = JSON.stringify(record);
      const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;
      validatePositiveLimit(maxRecordBytes, 'record limit');
      if (Buffer.byteLength(serialized, 'utf8') > maxRecordBytes) {
        throw limitError('record', maxRecordBytes);
      }
      if (!gzip.write(`${serialized}\n`)) await once(gzip, 'drain');
      count += 1;
    }
    gzip.end();
    await once(output, 'close');
    const handle = await fsp.open(tmpPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const bytes = (await fsp.stat(tmpPath)).size;
    await fsp.rename(tmpPath, filePath);
    return { count, bytes };
  } catch (error) {
    gzip.destroy();
    output.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    rethrowAbort(error, options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = {
  createQuotaBackpressuredJsonlGzipWriter,
  limitError,
  readJsonl,
  writeJsonlGzAtomic,
};
