'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable } = require('node:stream');
const { writeFileDurable, fsyncDirectory } = require('../../utils/durable-write.js');
const {
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
  RESULT_HANDLE_PATTERN,
  TERMINAL_STATES,
  assertIdentifier,
  assertOperationId,
  operationError,
} = require('./operation-contract.js');
const { canonicalJson } = require('../../../../shared/brain-operations/canonical-json.cjs');
const {
  OPERATION_AUTHORITY,
  authorityError,
  authorizeBrainOperation,
} = require('../../../../shared/brain-operations/authority.cjs');

const EXPORT_HANDLE_PATTERN = /^brexp_[A-Za-z0-9_-]{32}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const QUERY_MAX_BYTES = 64 * 1024;
const ANSWER_MAX_BYTES = 1024 * 1024;
const METADATA_MAX_BYTES = 64 * 1024;

function exactInputKeys(value, allowed, code = 'export_invalid') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw operationError(code);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) throw operationError(code);
  }
}

function authorizeStoredResultExport(record, requesterAgent) {
  const policy = record && OPERATION_AUTHORITY[record.operationType];
  if (!policy || record.requesterAgent !== requesterAgent) throw authorityError('access_denied');
  if (!TERMINAL_STATES.has(record.state)) throw authorityError('operation_not_terminal');
  if (policy.canonicalEvidence === false || record.canonicalEvidence !== true) {
    throw authorityError('canonical_export_required');
  }
  return policy;
}

function validateConfiguration(options) {
  if (!options || Array.isArray(options) || typeof options !== 'object') {
    throw operationError('export_configuration_invalid');
  }
  const allowed = new Set([
    'home23Root', 'requesterAgent', 'reader', 'now', 'randomBytes', 'crashInjector',
  ]);
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw operationError('export_configuration_invalid');
  }
  if (typeof options.home23Root !== 'string'
      || !path.isAbsolute(options.home23Root)
      || path.normalize(options.home23Root) !== options.home23Root
      || options.home23Root.includes('\0')) {
    throw operationError('export_configuration_invalid');
  }
  try {
    assertIdentifier(options.requesterAgent, 'requesterAgent');
  } catch (error) {
    throw operationError('export_configuration_invalid', error);
  }
  for (const method of [
    'getAuthorized', 'getResultAuthorized', 'openResultArtifactAuthorized',
  ]) {
    if (typeof options.reader?.[method] !== 'function') {
      throw operationError('export_configuration_invalid');
    }
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw operationError('export_configuration_invalid');
  }
  if (options.randomBytes !== undefined && typeof options.randomBytes !== 'function') {
    throw operationError('export_configuration_invalid');
  }
  if (options.crashInjector !== undefined && typeof options.crashInjector !== 'function') {
    throw operationError('export_configuration_invalid');
  }
}

function directoryIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
  };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function validateMetadataObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw operationError('export_invalid');
  }
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw operationError('export_invalid', error);
  }
  if (Buffer.byteLength(serialized, 'utf8') > METADATA_MAX_BYTES) {
    throw operationError('export_invalid');
  }
  return JSON.parse(serialized);
}

function validateBoundedText(value, maxBytes) {
  if (typeof value !== 'string'
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw operationError('export_invalid');
  }
  return value;
}

function validateFileName(fileName, extension) {
  if (fileName === undefined || fileName === null) return null;
  if (typeof fileName !== 'string'
      || fileName.length === 0
      || fileName.length > 128
      || fileName.trim() !== fileName
      || fileName.startsWith('.')
      || fileName.includes('/')
      || fileName.includes('\\')
      || fileName.includes('\0')
      || /[\u0000-\u001f\u007f]/.test(fileName)
      || path.basename(fileName) !== fileName
      || fileName === '.'
      || fileName === '..') {
    throw operationError('export_filename_invalid');
  }
  const suffix = `.${extension}`;
  const stem = fileName.endsWith(suffix) ? fileName.slice(0, -suffix.length) : fileName;
  if (!stem
      || stem.startsWith('.')
      || stem.length > 120
      || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(stem)) {
    throw operationError('export_filename_invalid');
  }
  return stem;
}

function publicReceipt(receipt) {
  return {
    exportHandle: receipt.exportHandle,
    relativePath: receipt.relativePath,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    sourceOperationId: receipt.sourceOperationId,
    sourceResultHandleHash: receipt.sourceResultHandleHash,
    format: receipt.format,
    canonicalEvidence: receipt.canonicalEvidence,
  };
}

class BrainOperationExporter {
  constructor(options) {
    validateConfiguration(options);
    this.home23Root = options.home23Root;
    this.requesterAgent = options.requesterAgent;
    this.reader = options.reader;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.crashInjector = options.crashInjector || (async () => {});
    this.instancesRoot = path.join(this.home23Root, 'instances');
    this.instanceRoot = path.join(this.instancesRoot, this.requesterAgent);
    this.workspaceRoot = path.join(this.instanceRoot, 'workspace');
    this.runtimeRoot = path.join(this.instanceRoot, 'runtime');
    this.exportRoot = path.join(this.workspaceRoot, 'brain-exports');
    this.receiptRoot = path.join(this.runtimeRoot, 'brain-export-receipts');
  }

  async _inject(stage, details = {}) {
    await this.crashInjector(stage, details);
  }

  _createdAt() {
    const raw = this.now();
    const milliseconds = raw instanceof Date ? raw.getTime()
      : typeof raw === 'string' ? Date.parse(raw) : raw;
    if (!Number.isFinite(milliseconds)) throw operationError('clock_invalid');
    return new Date(Number(milliseconds)).toISOString();
  }

  async _captureDirectories(paths, code = 'export_path_invalid') {
    const identities = [];
    for (const directoryPath of paths) {
      let stat;
      try {
        stat = await fsp.lstat(directoryPath, { bigint: true });
      } catch (error) {
        throw operationError(code, error);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw operationError(code);
      identities.push({ path: directoryPath, identity: directoryIdentity(stat) });
    }
    return identities;
  }

  async _verifyDirectories(identities, code = 'export_path_invalid') {
    for (const entry of identities) {
      let stat;
      try {
        stat = await fsp.lstat(entry.path, { bigint: true });
      } catch (error) {
        throw operationError(code, error);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()
          || !sameDirectoryIdentity(entry.identity, directoryIdentity(stat))) {
        throw operationError(code);
      }
    }
  }

  async _ensureChildDirectory(parentPath, childPath) {
    try {
      const existing = await fsp.lstat(childPath, { bigint: true });
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw operationError('export_path_invalid');
      }
      return;
    } catch (error) {
      if (error?.code === 'export_path_invalid') throw error;
      if (error.code !== 'ENOENT') throw operationError('export_path_invalid', error);
    }
    try {
      await fsp.mkdir(childPath, { recursive: false, mode: 0o700 });
      await fsyncDirectory(parentPath, { strict: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw operationError('export_path_invalid', error);
      const raced = await fsp.lstat(childPath, { bigint: true });
      if (!raced.isDirectory() || raced.isSymbolicLink()) {
        throw operationError('export_path_invalid');
      }
    }
  }

  async _prepareOutputDirectories() {
    const trusted = await this._captureDirectories([
      this.home23Root,
      this.instancesRoot,
      this.instanceRoot,
      this.workspaceRoot,
      this.runtimeRoot,
    ]);
    await this._ensureChildDirectory(this.workspaceRoot, this.exportRoot);
    await this._ensureChildDirectory(this.runtimeRoot, this.receiptRoot);
    await this._verifyDirectories(trusted);
    return this._captureDirectories([
      this.home23Root,
      this.instancesRoot,
      this.instanceRoot,
      this.workspaceRoot,
      this.runtimeRoot,
      this.exportRoot,
      this.receiptRoot,
    ]);
  }

  async _allocateDestination(operationId, format, fileName) {
    const extension = format === 'markdown' ? 'md' : format;
    const requestedStem = validateFileName(fileName, extension);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const random = this.randomBytes(24);
      if (!Buffer.isBuffer(random) || random.length !== 24) {
        throw operationError('export_configuration_invalid');
      }
      const exportHandle = `brexp_${random.toString('base64url')}`;
      if (!EXPORT_HANDLE_PATTERN.test(exportHandle)) throw operationError('export_configuration_invalid');
      const stem = requestedStem || `brain-operation-${operationId}`;
      const finalName = `${stem}-${exportHandle}.${extension}`;
      const finalPath = path.join(this.exportRoot, finalName);
      const receiptPath = path.join(this.receiptRoot, `${exportHandle}.json`);
      const reservationPath = path.join(this.receiptRoot, `.${exportHandle}.reserve`);
      let reservation;
      let ownsReservation = false;
      try {
        reservation = await fsp.open(
          reservationPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        ownsReservation = true;
        await reservation.sync();
        await reservation.close();
        reservation = null;
        await fsyncDirectory(this.receiptRoot, { strict: true });
      } catch (error) {
        if (reservation) await reservation.close().catch(() => {});
        if (ownsReservation) {
          await fsp.rm(reservationPath, { force: true }).catch(() => {});
          await fsyncDirectory(this.receiptRoot, { strict: true }).catch(() => {});
        }
        if (error.code === 'EEXIST') continue;
        throw operationError('export_path_invalid', error);
      }
      let collision = false;
      try {
        for (const candidate of [finalPath, receiptPath]) {
          try {
            await fsp.lstat(candidate);
            collision = true;
          } catch (error) {
            if (error.code !== 'ENOENT') throw operationError('export_path_invalid', error);
          }
        }
      } catch (error) {
        await fsp.rm(reservationPath, { force: true }).catch(() => {});
        await fsyncDirectory(this.receiptRoot, { strict: true }).catch(() => {});
        throw error;
      }
      if (!collision) {
        return {
          exportHandle,
          finalName,
          finalPath,
          receiptPath,
          reservationPath,
          relativePath: path.join('workspace', 'brain-exports', finalName),
        };
      }
      await fsp.rm(reservationPath, { force: true });
      await fsyncDirectory(this.receiptRoot, { strict: true });
    }
    throw operationError('export_conflict');
  }

  async _writeStreamToTemp(stream, tempPath, expected) {
    let handle;
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    try {
      handle = await fsp.open(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      try {
        for await (const rawChunk of stream) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          bytes += chunk.length;
          if (!Number.isSafeInteger(bytes) || bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES) {
            throw operationError('export_source_invalid');
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset, null);
            if (!Number.isSafeInteger(written.bytesWritten) || written.bytesWritten <= 0) {
              throw operationError('export_source_failed');
            }
            offset += written.bytesWritten;
          }
        }
      } catch (error) {
        if (error?.code?.startsWith?.('export_')) throw error;
        throw operationError('export_source_failed', error);
      }
      const sha256 = hash.digest('hex');
      if (expected && (bytes !== expected.bytes || sha256 !== expected.sha256)) {
        throw operationError('export_source_mismatch');
      }
      await handle.sync();
      await handle.close();
      handle = null;
      return { bytes, sha256 };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async _publish({
    operationId,
    format,
    fileName,
    stream,
    expected,
    sourceResultHandle,
    canonicalEvidence,
  }) {
    let identities;
    let destination;
    let tempPath = null;
    let published = false;
    try {
      identities = await this._prepareOutputDirectories();
      destination = await this._allocateDestination(operationId, format, fileName);
      tempPath = path.join(
        this.exportRoot,
        `.${destination.finalName}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
      );
      const measured = await this._writeStreamToTemp(stream, tempPath, expected);
      await this._inject('before_export_rename', {
        operationId,
        temporaryPath: tempPath,
        finalPath: destination.finalPath,
      });
      await this._verifyDirectories(identities);
      await fsp.rename(tempPath, destination.finalPath);
      published = true;
      await fsyncDirectory(this.exportRoot, { strict: true });
      await this._inject('after_export_rename', {
        operationId,
        finalPath: destination.finalPath,
      });
      await this._verifyDirectories(identities);

      const receipt = {
        version: 1,
        exportHandle: destination.exportHandle,
        createdAt: this._createdAt(),
        relativePath: destination.relativePath,
        bytes: measured.bytes,
        sha256: measured.sha256,
        sourceOperationId: operationId,
        sourceResultHandleHash: sourceResultHandle === null
          ? null
          : crypto.createHash('sha256').update(sourceResultHandle, 'utf8').digest('hex'),
        format,
        canonicalEvidence,
      };
      await writeFileDurable(
        destination.receiptPath,
        `${canonicalJson(receipt)}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
          strictDirectorySync: true,
          beforeRename: () => this._inject('before_export_receipt_rename', {
            operationId,
            receiptPath: destination.receiptPath,
          }),
          afterRename: () => this._inject('after_export_receipt_rename', {
            operationId,
            receiptPath: destination.receiptPath,
          }),
        },
      );
      await this._verifyDirectories(identities);
      await fsp.rm(destination.reservationPath, { force: true });
      await fsyncDirectory(this.receiptRoot, { strict: true });
      return publicReceipt(receipt);
    } catch (error) {
      if (!published) {
        if (tempPath) await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      if (error?.code === 'durability_uncertain') throw error;
      const uncertain = operationError('durability_uncertain', error);
      uncertain.published = true;
      throw uncertain;
    } finally {
      if (!published && tempPath) await fsp.rm(tempPath, { force: true }).catch(() => {});
      if (destination?.reservationPath) {
        await fsp.rm(destination.reservationPath, { force: true }).catch(() => {});
      }
      if (!published && typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy();
    }
  }

  _validateRequester(requesterAgent) {
    try {
      assertIdentifier(requesterAgent, 'requesterAgent');
    } catch (error) {
      throw authorityError('access_denied', error);
    }
    if (requesterAgent !== this.requesterAgent) throw authorityError('access_denied');
  }

  async exportResult(input) {
    exactInputKeys(input, [
      'requesterAgent', 'operationId', 'resultHandle', 'format', 'fileName',
    ]);
    this._validateRequester(input.requesterAgent);
    assertOperationId(input.operationId);
    const record = await this.reader.getAuthorized(input.operationId);
    authorizeStoredResultExport(record, this.requesterAgent);

    if (record.operationType === 'graph_export') {
      if (input.format !== 'jsonl') throw operationError('export_format_invalid');
      validateFileName(input.fileName, 'jsonl');
      const artifact = record.resultArtifact;
      const artifactKeys = artifact && !Array.isArray(artifact) && typeof artifact === 'object'
        ? Reflect.ownKeys(artifact)
        : [];
      if (record.result !== null
          || !artifact
          || artifactKeys.some((key) => typeof key !== 'string')
          || artifactKeys.length !== 4
          || !['mediaType', 'contentEncoding', 'bytes', 'sha256']
            .every((key) => Object.hasOwn(artifact, key))
          || artifact.mediaType !== 'application/x-ndjson'
          || artifact.contentEncoding !== 'identity'
          || !Number.isSafeInteger(artifact.bytes)
          || artifact.bytes < 0
          || artifact.bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES
          || typeof artifact.sha256 !== 'string'
          || !SHA256_HEX_PATTERN.test(artifact.sha256)
          || typeof record.resultHandle !== 'string'
          || !RESULT_HANDLE_PATTERN.test(record.resultHandle)) {
        throw operationError('export_source_invalid');
      }
      const opened = await this.reader.openResultArtifactAuthorized(
        input.operationId,
        input.resultHandle,
      );
      const metadata = opened?.metadata;
      const metadataKeys = metadata && !Array.isArray(metadata) && typeof metadata === 'object'
        ? Reflect.ownKeys(metadata)
        : [];
      if (!metadata
          || metadataKeys.some((key) => typeof key !== 'string')
          || metadataKeys.length !== 4
          || !['mediaType', 'contentEncoding', 'bytes', 'sha256']
            .every((key) => Object.hasOwn(metadata, key))
          || metadata.mediaType !== artifact.mediaType
          || metadata.contentEncoding !== artifact.contentEncoding
          || metadata.bytes !== artifact.bytes
          || metadata.sha256 !== artifact.sha256
          || !opened.stream
          || typeof opened.stream[Symbol.asyncIterator] !== 'function') {
        if (typeof opened?.stream?.destroy === 'function') opened.stream.destroy();
        throw operationError('export_source_invalid');
      }
      return this._publish({
        operationId: input.operationId,
        format: input.format,
        fileName: input.fileName,
        stream: opened.stream,
        expected: { bytes: artifact.bytes, sha256: artifact.sha256 },
        sourceResultHandle: record.resultHandle,
        canonicalEvidence: true,
      });
    }

    if (record.resultArtifact !== null && record.resultArtifact !== undefined) {
      const metadata = record.resultArtifact;
      const keys = metadata && !Array.isArray(metadata) && typeof metadata === 'object'
        ? Reflect.ownKeys(metadata)
        : [];
      if (keys.some((key) => typeof key !== 'string')
          || keys.length !== 4
          || !['mediaType', 'contentEncoding', 'bytes', 'sha256']
            .every((key) => Object.hasOwn(metadata, key))
          || metadata.mediaType !== 'application/json'
          || metadata.contentEncoding !== 'identity'
          || !Number.isSafeInteger(metadata.bytes)
          || metadata.bytes < 0
          || typeof metadata.sha256 !== 'string'
          || !SHA256_HEX_PATTERN.test(metadata.sha256)
          || typeof record.resultHandle !== 'string'
          || !RESULT_HANDLE_PATTERN.test(record.resultHandle)) {
        throw operationError('export_source_invalid');
      }
    }
    if (input.format !== 'json' && input.format !== 'markdown') {
      throw operationError('export_format_invalid');
    }
    validateFileName(input.fileName, input.format === 'markdown' ? 'md' : 'json');
    const result = await this.reader.getResultAuthorized(input.operationId, input.resultHandle);
    let serialized;
    try {
      serialized = canonicalJson(result);
    } catch (error) {
      throw operationError('export_source_invalid', error);
    }
    const content = input.format === 'json'
      ? `${serialized}\n`
      : `# Brain Operation Result\n\n\`\`\`json\n${serialized}\n\`\`\`\n`;
    return this._publish({
      operationId: input.operationId,
      format: input.format,
      fileName: input.fileName,
      stream: Readable.from([Buffer.from(content, 'utf8')]),
      expected: null,
      sourceResultHandle: record.resultHandle || null,
      canonicalEvidence: true,
    });
  }

  async exportAdHoc(input) {
    exactInputKeys(input, [
      'requesterAgent', 'operationId', 'query', 'answer', 'format', 'metadata',
    ]);
    this._validateRequester(input.requesterAgent);
    assertOperationId(input.operationId);
    const query = validateBoundedText(input.query, QUERY_MAX_BYTES);
    const answer = validateBoundedText(input.answer, ANSWER_MAX_BYTES);
    const metadata = validateMetadataObject(input.metadata);
    if (input.format !== 'json' && input.format !== 'markdown') {
      throw operationError('export_format_invalid');
    }
    authorizeBrainOperation({
      requesterAgent: this.requesterAgent,
      operationType: 'ad_hoc_export',
      target: { domain: 'requester', requesterAgent: this.requesterAgent },
    });
    const payload = { query, answer, metadata };
    const content = input.format === 'json'
      ? `${canonicalJson(payload)}\n`
      : `# Brain Query Export\n\n## Query\n\n${query}\n\n## Answer\n\n${answer}\n`;
    return this._publish({
      operationId: input.operationId,
      format: input.format,
      fileName: null,
      stream: Readable.from([Buffer.from(content, 'utf8')]),
      expected: null,
      sourceResultHandle: null,
      canonicalEvidence: false,
    });
  }
}

function createBrainOperationExporter(options) {
  return new BrainOperationExporter(options);
}

module.exports = {
  ANSWER_MAX_BYTES,
  BrainOperationExporter,
  EXPORT_HANDLE_PATTERN,
  METADATA_MAX_BYTES,
  QUERY_MAX_BYTES,
  authorizeStoredResultExport,
  createBrainOperationExporter,
};
