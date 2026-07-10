'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
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
} = require('./confined-file.cjs');

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

async function* readJsonl(filePath, options = {}) {
  throwIfAborted(options.signal);
  const confinedRoot = options.confinedRoot || path.dirname(filePath);
  const opened = await openConfinedRegularFile(confinedRoot, filePath, {
    flags: fs.constants.O_RDONLY,
    maxBytes: options.maxInputBytes,
    signal: options.signal,
  });
  const stat = opened.stat;
  if (options.expectedInputBytes !== undefined
      && (!Number.isSafeInteger(options.expectedInputBytes)
        || options.expectedInputBytes < 0
        || Number(stat.size) !== options.expectedInputBytes)) {
    await opened.handle.close();
    throw memorySourceError('source_unavailable', 'authoritative JSONL size mismatch', {
      retryable: true,
    });
  }
  const inputBytes = options.byteLimit === undefined ? Number(stat.size) : options.byteLimit;
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
    await opened.handle.close();
    throw memorySourceError('invalid_request', 'invalid JSONL byte limit');
  }
  if (inputBytes > Number(stat.size)) {
    await opened.handle.close();
    throw memorySourceError('source_unavailable', 'committed JSONL prefix is truncated', {
      retryable: true,
    });
  }
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;
  const maxDecompressedBytes = options.maxDecompressedBytes ?? 2 * 1024 * 1024 * 1024;
  validatePositiveLimit(maxRecordBytes, 'record limit');
  validatePositiveLimit(maxDecompressedBytes, 'decompressed limit');
  if (inputBytes === 0) {
    await assertStableOpenedFile(opened);
    await opened.handle.close();
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
    await assertStableOpenedFile(opened);
  } catch (error) {
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)) throw error;
    throw memorySourceError('source_unavailable', 'authoritative JSONL source is unreadable', {
      cause: error,
      retryable: true,
    });
  } finally {
    options.signal?.removeEventListener('abort', abort);
    decoded.destroy();
    input.destroy();
    await opened.handle.close().catch(() => {});
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
  limitError,
  readJsonl,
  writeJsonlGzAtomic,
};
