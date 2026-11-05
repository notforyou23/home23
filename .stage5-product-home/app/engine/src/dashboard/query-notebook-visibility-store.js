'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const properLockfile = require('proper-lockfile');
const {
  assertIdentifier,
  assertOperationId,
} = require('./brain-operations/operation-contract.js');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_EXISTING_OPERATION_IDS = 100_000;

function visibilityError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function exactKeys(value, allowed, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw visibilityError(code);
  }
  const accepted = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== accepted.size
      || keys.some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw visibilityError(code);
  }
  return value;
}

function canonicalIso(value, code) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value) throw visibilityError(code);
  return value;
}

function currentIso(now) {
  const raw = now();
  const milliseconds = raw instanceof Date ? raw.getTime()
    : typeof raw === 'string' ? Date.parse(raw) : raw;
  if (!Number.isFinite(milliseconds)) throw visibilityError('visibility_store_unavailable');
  return new Date(Number(milliseconds)).toISOString();
}

function checkedOperationId(value) {
  try { return assertOperationId(value); } catch (error) {
    throw visibilityError('visibility_invalid', error);
  }
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

function createQueryNotebookVisibilityStore(options = {}) {
  exactKeys(options, [
    'filePath', 'requesterAgent',
    ...(Object.hasOwn(options, 'now') ? ['now'] : []),
    ...(Object.hasOwn(options, 'maxEntries') ? ['maxEntries'] : []),
  ], 'visibility_configuration_invalid');
  if (typeof options.filePath !== 'string' || !path.isAbsolute(options.filePath)
      || path.normalize(options.filePath) !== options.filePath || options.filePath.includes('\0')) {
    throw visibilityError('visibility_configuration_invalid');
  }
  let requesterAgent;
  try { requesterAgent = assertIdentifier(options.requesterAgent, 'requesterAgent'); } catch (error) {
    throw visibilityError('visibility_configuration_invalid', error);
  }
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (typeof now !== 'function' || !Number.isSafeInteger(maxEntries)
      || maxEntries < 1 || maxEntries > DEFAULT_MAX_ENTRIES) {
    throw visibilityError('visibility_configuration_invalid');
  }
  const parent = path.dirname(options.filePath);
  const anchorPath = `${options.filePath}.anchor`;

  function emptyDocument() {
    return { schemaVersion: SCHEMA_VERSION, requesterAgent, hidden: new Map() };
  }

  function parseDocument(bytes) {
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      exactKeys(parsed, ['schemaVersion', 'requesterAgent', 'hidden'],
        'visibility_store_corrupt');
      if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.requesterAgent !== requesterAgent
          || !parsed.hidden || Array.isArray(parsed.hidden)
          || typeof parsed.hidden !== 'object') {
        throw visibilityError('visibility_store_corrupt');
      }
      const entries = Object.entries(parsed.hidden);
      if (entries.length > maxEntries) throw visibilityError('visibility_store_corrupt');
      const hidden = new Map();
      for (const [operationId, hiddenAt] of entries) {
        try { assertOperationId(operationId); } catch (error) {
          throw visibilityError('visibility_store_corrupt', error);
        }
        hidden.set(operationId, canonicalIso(hiddenAt, 'visibility_store_corrupt'));
      }
      return { schemaVersion: SCHEMA_VERSION, requesterAgent, hidden };
    } catch (error) {
      if (error?.code === 'visibility_store_corrupt') throw error;
      throw visibilityError('visibility_store_corrupt', error);
    }
  }

  async function readDocument() {
    let handle;
    try {
      handle = await fsp.open(
        options.filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
        throw visibilityError('visibility_store_corrupt');
      }
      return parseDocument(await handle.readFile());
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyDocument();
      if (error?.code === 'visibility_store_corrupt') throw error;
      if (error?.code === 'ELOOP') throw visibilityError('visibility_store_corrupt', error);
      throw visibilityError('visibility_store_unavailable', error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeDocument(document) {
    const hidden = Object.create(null);
    for (const operationId of [...document.hidden.keys()].sort()) {
      hidden[operationId] = document.hidden.get(operationId);
    }
    const bytes = Buffer.from(`${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      requesterAgent,
      hidden,
    })}\n`, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) throw visibilityError('visibility_capacity_exceeded');
    const temporary = path.join(
      parent,
      `.${path.basename(options.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let handle;
    let renamed = false;
    try {
      handle = await fsp.open(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, options.filePath);
      renamed = true;
      await fsp.chmod(options.filePath, 0o600);
      await fsyncDirectory(parent);
    } catch (error) {
      if (error?.code === 'visibility_capacity_exceeded') throw error;
      throw visibilityError('visibility_store_unavailable', error);
    } finally {
      await handle?.close().catch(() => {});
      if (!renamed) await fsp.unlink(temporary).catch(() => {});
    }
  }

  async function ensureAnchor() {
    try {
      await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await fsp.open(
          anchorPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        await handle.writeFile(`${options.filePath}\n`);
        await handle.sync();
        await handle.close();
        handle = null;
        await fsyncDirectory(parent);
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
      }
      const stat = await fsp.lstat(anchorPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw visibilityError('visibility_store_corrupt');
      return anchorPath;
    } catch (error) {
      if (error?.code === 'visibility_store_corrupt') throw error;
      throw visibilityError('visibility_store_unavailable', error);
    }
  }

  async function withLock(callback) {
    const anchor = await ensureAnchor();
    let release;
    try {
      release = await properLockfile.lock(anchor, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 200, factor: 1.1, minTimeout: 5, maxTimeout: 50 },
      });
      return await callback();
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('visibility_')) throw error;
      throw visibilityError('visibility_store_unavailable', error);
    } finally {
      await release?.().catch(() => {});
    }
  }

  async function hiddenOperationIds() {
    return [...(await readDocument()).hidden.keys()].sort();
  }

  async function isHidden(operationId) {
    checkedOperationId(operationId);
    return (await readDocument()).hidden.has(operationId);
  }

  async function hide(operationId) {
    checkedOperationId(operationId);
    return withLock(async () => {
      const document = await readDocument();
      if (document.hidden.has(operationId)) return false;
      if (document.hidden.size >= maxEntries) {
        throw visibilityError('visibility_capacity_exceeded');
      }
      document.hidden.set(operationId, currentIso(now));
      await writeDocument(document);
      return true;
    });
  }

  async function prune(existingOperationIds) {
    if (!Array.isArray(existingOperationIds)
        || existingOperationIds.length > MAX_EXISTING_OPERATION_IDS
        || new Set(existingOperationIds).size !== existingOperationIds.length) {
      throw visibilityError('visibility_invalid');
    }
    for (const operationId of existingOperationIds) checkedOperationId(operationId);
    const existing = new Set(existingOperationIds);
    return withLock(async () => {
      const document = await readDocument();
      let removed = 0;
      for (const operationId of [...document.hidden.keys()]) {
        if (existing.has(operationId)) continue;
        document.hidden.delete(operationId);
        removed += 1;
      }
      if (removed > 0) await writeDocument(document);
      return removed;
    });
  }

  return Object.freeze({ hiddenOperationIds, hide, isHidden, prune });
}

module.exports = {
  createQueryNotebookVisibilityStore,
};
