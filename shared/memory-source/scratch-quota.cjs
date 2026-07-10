'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { memorySourceError } = require('./contracts.cjs');

async function assertOperationRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
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

async function createOperationScratchQuota({ operationRoot, maxBytes = 8 * 1024 * 1024 * 1024 } = {}) {
  const root = await assertOperationRoot(operationRoot);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw memorySourceError('invalid_request', 'invalid scratch quota');
  }
  let usedBytes = 0;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw memorySourceError('invalid_request', 'scratch quota is closed');
  };
  return Object.freeze({
    operationRoot: root,
    maxBytes,
    async claim(bytes, kind = 'scratch') {
      assertOpen();
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw memorySourceError('invalid_request', 'invalid scratch claim');
      }
      if (usedBytes + bytes > maxBytes) {
        throw memorySourceError('result_too_large', `${kind} scratch quota exceeded`, {
          status: 413,
          retryable: false,
        });
      }
      usedBytes += bytes;
      return usedBytes;
    },
    async release(bytes) {
      assertOpen();
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > usedBytes) {
        throw memorySourceError('invalid_request', 'invalid scratch release');
      }
      usedBytes -= bytes;
      return usedBytes;
    },
    async reconcile() {
      assertOpen();
      return usedBytes;
    },
    get usedBytes() { return usedBytes; },
    close() { closed = true; },
  });
}

module.exports = {
  assertOperationRoot,
  createOperationScratchQuota,
};
