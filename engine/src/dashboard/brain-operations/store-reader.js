'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { BrainOperationStore } = require('./operation-store.js');
const {
  RESULT_HANDLE_PATTERN,
  assertIdentifier,
  assertOperationId,
  assertResultHandle,
  operationError,
  safeJsonClone,
} = require('./operation-contract.js');

function assertConfiguration(options) {
  if (!options || Array.isArray(options) || typeof options !== 'object') {
    throw operationError('reader_configuration_invalid');
  }
  const allowed = new Set(['operationsRoot', 'expectedRequester', 'liveStore']);
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw operationError('reader_configuration_invalid');
  }
  if (typeof options.operationsRoot !== 'string'
      || !path.isAbsolute(options.operationsRoot)
      || path.normalize(options.operationsRoot) !== options.operationsRoot
      || options.operationsRoot.includes('\0')) {
    throw operationError('reader_configuration_invalid');
  }
  try {
    assertIdentifier(options.expectedRequester, 'expectedRequester');
  } catch (error) {
    throw operationError('reader_configuration_invalid', error);
  }
  if (options.liveStore !== undefined && options.liveStore !== null) {
    for (const method of ['get', 'listNonterminal', 'getResult', 'openResultArtifact']) {
      if (typeof options.liveStore[method] !== 'function') {
        throw operationError('reader_configuration_invalid');
      }
    }
  }
}

function handlesMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
      || !RESULT_HANDLE_PATTERN.test(left) || !RESULT_HANDLE_PATTERN.test(right)) return false;
  const leftHash = crypto.createHash('sha256').update(left, 'utf8').digest();
  const rightHash = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

class BrainOperationStoreReader {
  constructor(options) {
    assertConfiguration(options);
    this.operationsRoot = options.operationsRoot;
    this.expectedRequester = options.expectedRequester;
    try {
      this.store = options.liveStore || new BrainOperationStore({
        root: options.operationsRoot,
        requesterAgent: options.expectedRequester,
      });
    } catch (error) {
      throw operationError('reader_configuration_invalid', error);
    }
    Object.defineProperties(this, {
      operationsRoot: { writable: false },
      expectedRequester: { writable: false },
      store: { writable: false },
    });
  }

  _authorizeRecord(rawRecord, expectedOperationId = null) {
    let record;
    try {
      record = safeJsonClone(rawRecord, 'operation_corrupt');
    } catch (error) {
      throw operationError('operation_corrupt', error);
    }
    if (!record || Array.isArray(record) || typeof record !== 'object') {
      throw operationError('operation_corrupt');
    }
    try {
      assertOperationId(record.operationId);
    } catch (error) {
      throw operationError('operation_corrupt', error);
    }
    if (expectedOperationId !== null && record.operationId !== expectedOperationId) {
      throw operationError('operation_corrupt');
    }
    if (record.requesterAgent !== this.expectedRequester) throw operationError('access_denied');
    return record;
  }

  _effectiveHandle(record, suppliedHandle) {
    if (suppliedHandle !== undefined && suppliedHandle !== null) {
      assertResultHandle(suppliedHandle);
      if (!handlesMatch(record.resultHandle, suppliedHandle)) {
        throw operationError('result_handle_invalid');
      }
      return suppliedHandle;
    }
    if (record.resultHandle === null || record.resultHandle === undefined) return null;
    if (typeof record.resultHandle !== 'string' || !RESULT_HANDLE_PATTERN.test(record.resultHandle)) {
      throw operationError('operation_corrupt');
    }
    return record.resultHandle;
  }

  async getAuthorized(operationId) {
    assertOperationId(operationId);
    return this._authorizeRecord(await this.store.get(operationId), operationId);
  }

  async listNonterminalAuthorized() {
    const source = await this.store.listNonterminal();
    if (!Array.isArray(source)) throw operationError('operation_corrupt');
    const records = source.map((record) => this._authorizeRecord(record));
    return records
      .filter((record) => record.state === 'queued' || record.state === 'running')
      .sort((left, right) =>
        String(left.updatedAt || '').localeCompare(String(right.updatedAt || ''))
        || String(left.operationId || '').localeCompare(String(right.operationId || '')));
  }

  async getResultAuthorized(operationId, resultHandle) {
    const record = await this.getAuthorized(operationId);
    const effectiveHandle = this._effectiveHandle(record, resultHandle);
    return this.store.getResult(operationId, {
      requesterAgent: this.expectedRequester,
      resultHandle: effectiveHandle,
    });
  }

  async openResultArtifactAuthorized(operationId, resultHandle) {
    const record = await this.getAuthorized(operationId);
    const effectiveHandle = this._effectiveHandle(record, resultHandle);
    return this.store.openResultArtifact(operationId, {
      requesterAgent: this.expectedRequester,
      resultHandle: effectiveHandle,
    });
  }
}

function createBrainOperationStoreReader(options) {
  return new BrainOperationStoreReader(options);
}

module.exports = {
  BrainOperationStoreReader,
  createBrainOperationStoreReader,
};
