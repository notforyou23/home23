'use strict';

const fs = require('node:fs');
const fsp = fs.promises;

function tailError(code, message, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function boundedPositiveInteger(value, fallback, max) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw tailError('invalid_request', 'tail limit must be a positive bounded integer', {
      status: 400,
    });
  }
  return resolved;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || tailError('cancelled', 'cancelled');
}

async function readRecentJsonlTail(filePath, {
  limit = 20,
  maxEntries = 100,
  maxBytes = 8 * 1024 * 1024,
  maxLineBytes = 256 * 1024,
  signal,
} = {}) {
  const count = boundedPositiveInteger(limit, 20, maxEntries);
  if (typeof filePath !== 'string' || !filePath
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > maxBytes) {
    throw tailError('invalid_request', 'invalid bounded JSONL tail options', { status: 400 });
  }
  throwIfAborted(signal);
  let handle;
  try {
    handle = await fsp.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw tailError('source_unavailable', 'JSONL tail is not a regular file');
    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, bytesToRead - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    throwIfAborted(signal);
    let text = buffer.subarray(0, offset).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const selected = lines.slice(-count);
    const rows = [];
    for (const line of selected) {
      throwIfAborted(signal);
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        throw tailError('result_too_large', 'JSONL tail record exceeds byte limit', {
          status: 413,
        });
      }
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        throw tailError('source_unavailable', 'JSONL tail contains an invalid record', {
          retryable: true,
          cause: error,
        });
      }
    }
    return rows.reverse();
  } finally {
    await handle.close();
  }
}

module.exports = {
  readRecentJsonlTail,
};
