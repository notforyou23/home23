'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {
  memorySourceError,
  readJsonlRange,
  throwIfAborted,
  validateManifest,
} = require('../../../shared/memory-source');
const {
  nextDeltaChainDigest,
} = require('../../../shared/memory-source/delta-chain.cjs');

const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_CHANGED_NODES = 100_000;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  const id = String(value);
  return id && Buffer.byteLength(id, 'utf8') <= DEFAULT_MAX_RECORD_BYTES ? id : null;
}

function fileSignature(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameManifestIdentity(signature, identity) {
  return Boolean(signature && identity
    && signature.dev === identity.dev
    && signature.ino === identity.ino
    && String(signature.size) === identity.size
    && signature.mtimeNs === identity.mtimeNs
    && signature.ctimeNs === identity.ctimeNs);
}

function provesSingleAppend(previousState, activeDelta) {
  const authority = activeDelta?.appendFrom;
  return Boolean(authority
    && authority.committedBytes === previousState.committedBytes
    && authority.count === previousState.deltaRecords
    && sameManifestIdentity(previousState.fileSignature, authority.fileIdentity));
}

function hasChainAuthority(activeDelta) {
  return typeof activeDelta?.chainDigest === 'string'
    && typeof activeDelta?.chainBaseDigest === 'string'
    && Number.isSafeInteger(activeDelta?.chainBaseCount)
    && Number.isSafeInteger(activeDelta?.chainBaseBytes);
}

function sameChainBase(state, activeDelta) {
  return state.chainBaseCount === activeDelta.chainBaseCount
    && state.chainBaseBytes === activeDelta.chainBaseBytes
    && state.chainBaseDigest === activeDelta.chainBaseDigest;
}

function snapshotFromState(state, cachePath) {
  const upserts = new Map(state.upserts.map((node) => [String(node.id), deepFreeze(node)]));
  const removed = new Set(state.removedNodeIds.map(String));
  const changed = new Set(state.changedNodeIds.map(String));
  const frozenUpserts = Object.freeze([...upserts.values()]);
  const frozenChanged = Object.freeze([...changed]);
  const frozenRemoved = Object.freeze([...removed]);
  return Object.freeze({
    canonicalRoot: state.canonicalRoot,
    generation: state.generation,
    epoch: state.epoch,
    baseRevision: state.baseRevision,
    coveredThroughRevision: state.coveredThroughRevision,
    committedBytes: state.committedBytes,
    deltaRecords: state.deltaRecords,
    edgeOnlyRecords: state.edgeOnlyRecords,
    changedNodeCount: changed.size,
    upsertedNodeCount: upserts.size,
    removedNodeCount: removed.size,
    cachePath,
    fileSignature: state.fileSignature,
    node(id) { return upserts.get(String(id)) || null; },
    hasNodeUpsert(id) { return upserts.has(String(id)); },
    hasChangedNode(id) { return changed.has(String(id)); },
    hasRemovedNode(id) { return removed.has(String(id)); },
    nodeUpserts() { return frozenUpserts; },
    changedNodeIds() { return frozenChanged; },
    removedNodeIds() { return frozenRemoved; },
  });
}

function retainedStateBytes(state) {
  let bytes = 0;
  for (const node of state.upserts || []) {
    const id = String(node?.id ?? '');
    bytes += Buffer.byteLength(id, 'utf8') + Buffer.byteLength(JSON.stringify(node), 'utf8');
  }
  for (const id of state.removedNodeIds || []) bytes += Buffer.byteLength(String(id), 'utf8');
  for (const id of state.changedNodeIds || []) bytes += Buffer.byteLength(String(id), 'utf8');
  return bytes;
}

async function hashFileRange(filePath, startByte, endByte, signal, hooks = {}) {
  const handle = await fsp.open(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < endByte) {
      throw memorySourceError('source_unavailable', 'committed delta prefix is truncated', {
        retryable: true,
      });
    }
    let position = startByte;
    while (position < endByte) {
      throwIfAborted(signal);
      const length = Math.min(chunk.length, endByte - position);
      const read = await handle.read(chunk, 0, length, position);
      if (read.bytesRead <= 0) {
        throw memorySourceError('source_unavailable', 'committed delta prefix is truncated', {
          retryable: true,
        });
      }
      hash.update(chunk.subarray(0, read.bytesRead));
      await hooks.onPrefixRead?.({ startByte: position, endByte: position + read.bytesRead });
      position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathStat = await fsp.lstat(filePath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.dev !== pathStat.dev || before.ino !== pathStat.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) {
      throw memorySourceError('source_changed', 'delta changed while hashing committed prefix', {
        retryable: true,
      });
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function createMemoryDeltaOverlayCache(options = {}) {
  if (!options.cacheRoot || typeof options.cacheRoot !== 'string') {
    throw memorySourceError('invalid_request', 'requester cache root required');
  }
  const cacheRoot = path.resolve(options.cacheRoot);
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxRetainedBytes = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
  const maxChangedNodes = options.maxChangedNodes ?? DEFAULT_MAX_CHANGED_NODES;
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  for (const [name, value] of Object.entries({ maxRetainedBytes, maxChangedNodes, maxCacheBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw memorySourceError('invalid_request', `invalid ${name}`);
    }
  }
  const hooks = options._testHooks || {};
  let current = null;
  let refreshTail = Promise.resolve();

  async function refreshNow({ canonicalRoot, manifest: inputManifest, signal } = {}) {
    throwIfAborted(signal);
    const root = await fsp.realpath(canonicalRoot);
    const manifest = validateManifest(inputManifest);
    const deltaPath = path.join(root, manifest.activeDelta.file);
    if (path.dirname(deltaPath) !== root) {
      throw memorySourceError('invalid_memory_source', 'delta path escapes source', { retryable: false });
    }
    const stat = await fsp.lstat(deltaPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw memorySourceError('invalid_memory_source', 'delta must be a regular nonsymlink file', {
        retryable: false,
      });
    }
    const signature = fileSignature(stat);
    if (manifest.activeDelta.fileIdentity
        && !sameManifestIdentity(signature, manifest.activeDelta.fileIdentity)) {
      throw memorySourceError('source_changed', 'committed delta identity differs from manifest', {
        retryable: true,
      });
    }
    if (signature.size < manifest.activeDelta.committedBytes) {
      throw memorySourceError('source_unavailable', 'committed delta is truncated', { retryable: true });
    }
    const cacheKey = crypto.createHash('sha256')
      .update(`${root}\0${manifest.generation}\0${manifest.activeDeltaEpoch}\0${manifest.activeDelta.file}`)
      .digest('hex');
    const directory = path.join(cacheRoot, 'brain-delta-overlays', cacheKey);
    const cachePath = path.join(directory, 'state.json');
    if (!current) {
      try {
        const cacheStat = await fsp.lstat(cachePath);
        if (cacheStat.isSymbolicLink() || !cacheStat.isFile()
            || cacheStat.size > Math.min(maxInputBytes, maxCacheBytes)) {
          throw new Error('unsafe persisted overlay cache');
        }
        const persisted = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        const structurallyValid = persisted?.canonicalRoot === root
          && persisted.generation === manifest.generation
          && persisted.epoch === manifest.activeDeltaEpoch
          && persisted.deltaFile === manifest.activeDelta.file
          && persisted.baseRevision === manifest.baseRevision
          && Number.isSafeInteger(persisted.committedBytes)
          && persisted.committedBytes >= 0
          && persisted.committedBytes <= manifest.activeDelta.committedBytes
          && Number.isSafeInteger(persisted.deltaRecords)
          && persisted.deltaRecords >= 0
          && persisted.deltaRecords <= manifest.activeDelta.count
          && Array.isArray(persisted.upserts)
          && Array.isArray(persisted.removedNodeIds)
          && Array.isArray(persisted.changedNodeIds)
          && /^[a-f0-9]{64}$/.test(persisted.committedPrefixDigest || '')
          && persisted.upserts.length <= persisted.deltaRecords
          && persisted.removedNodeIds.length <= persisted.deltaRecords
          && persisted.changedNodeIds.length <= persisted.deltaRecords
          && sameFile(persisted.fileSignature, signature);
        if (structurallyValid
            && persisted.changedNodeIds.length <= maxChangedNodes
            && retainedStateBytes(persisted) <= maxRetainedBytes) {
          const snapshot = snapshotFromState(persisted, cachePath);
          current = { state: persisted, snapshot };
          await hooks.onDiskLoad?.({ cachePath });
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }
    const sameAuthority = current
      && current.state.canonicalRoot === root
      && current.state.generation === manifest.generation
      && current.state.epoch === manifest.activeDeltaEpoch
      && current.state.deltaFile === manifest.activeDelta.file
      && sameFile(current.state.fileSignature, signature);
    const unchanged = sameAuthority
      && current.state.committedBytes === manifest.activeDelta.committedBytes
      && current.state.deltaRecords === manifest.activeDelta.count
      && unchangedFile(current.state.fileSignature, signature);
    if (unchanged) return current.snapshot;

    const canExtend = sameAuthority
      && manifest.activeDelta.committedBytes > current.state.committedBytes
      && manifest.activeDelta.count > current.state.deltaRecords
      && typeof current.state.committedPrefixDigest === 'string'
      && ((hasChainAuthority(manifest.activeDelta)
          && /^[a-f0-9]{64}$/.test(current.state.committedChainDigest || '')
          && sameChainBase(current.state, manifest.activeDelta))
        || (!hasChainAuthority(manifest.activeDelta)
          && provesSingleAppend(current.state, manifest.activeDelta)));
    const state = canExtend ? {
      ...current.state,
      upserts: current.state.upserts.slice(),
      removedNodeIds: current.state.removedNodeIds.slice(),
      changedNodeIds: current.state.changedNodeIds.slice(),
    } : {
      canonicalRoot: root,
      generation: manifest.generation,
      epoch: manifest.activeDeltaEpoch,
      deltaFile: manifest.activeDelta.file,
      baseRevision: manifest.baseRevision,
      coveredThroughRevision: manifest.baseRevision,
      committedBytes: 0,
      deltaRecords: 0,
      edgeOnlyRecords: 0,
      upserts: [],
      removedNodeIds: [],
      changedNodeIds: [],
      fileSignature: signature,
      committedPrefixDigest: null,
      committedChainDigest: null,
      chainBaseCount: manifest.activeDelta.chainBaseCount ?? null,
      chainBaseBytes: manifest.activeDelta.chainBaseBytes ?? null,
      chainBaseDigest: manifest.activeDelta.chainBaseDigest ?? null,
    };
    const upserts = new Map(state.upserts.map((node) => [String(node.id), node]));
    const removed = new Set(state.removedNodeIds.map(String));
    const changed = new Set(state.changedNodeIds.map(String));
    const upsertBytes = new Map();
    let retainedBytes = 0;
    for (const [id, node] of upserts) {
      const bytes = Buffer.byteLength(id, 'utf8') + Buffer.byteLength(JSON.stringify(node), 'utf8');
      upsertBytes.set(id, bytes);
      retainedBytes += bytes;
    }
    for (const id of removed) retainedBytes += Buffer.byteLength(id, 'utf8');
    for (const id of changed) retainedBytes += Buffer.byteLength(id, 'utf8');
    const chainAuthority = hasChainAuthority(manifest.activeDelta);
    const startByte = canExtend ? state.committedBytes : 0;
    let rangeDigest = null;
    let expectedChainDigest = canExtend && chainAuthority
      ? current.state.committedChainDigest
      : (chainAuthority ? manifest.activeDelta.chainBaseDigest : null);
    if (!chainAuthority || !canExtend) {
      const hashEndByte = chainAuthority
        ? manifest.activeDelta.chainBaseBytes
        : manifest.activeDelta.committedBytes;
      rangeDigest = await hashFileRange(deltaPath, 0, hashEndByte, signal, hooks);
      if (chainAuthority && rangeDigest !== manifest.activeDelta.chainBaseDigest) {
        throw memorySourceError('source_changed', 'delta chain base differs from manifest', {
          retryable: true,
        });
      }
    } else {
      await hooks.onPrefixRead?.({
        startByte,
        endByte: manifest.activeDelta.committedBytes,
      });
    }
    let expectedSequence = canExtend ? state.deltaRecords + 1 : 1;
    let expectedRevision = manifest.baseRevision + expectedSequence;
    let imported = 0;
    await hooks.onReadRange?.({ startByte, endByte: manifest.activeDelta.committedBytes });
    for await (const entry of readJsonlRange(deltaPath, {
      confinedRoot: root,
      startByte,
      endByte: manifest.activeDelta.committedBytes,
      maxInputBytes,
      maxRecordBytes,
      signal,
    })) {
      throwIfAborted(signal);
      if (entry?.epoch !== manifest.activeDeltaEpoch
          || entry.sequence !== expectedSequence
          || entry.revision !== expectedRevision) {
        throw memorySourceError('source_unavailable', 'committed delta is not contiguous', {
          retryable: true,
        });
      }
      if (chainAuthority && entry.sequence > manifest.activeDelta.chainBaseCount) {
        const { previousDigest, chainDigest, ...payload } = entry;
        let computed;
        try {
          computed = nextDeltaChainDigest(expectedChainDigest, payload);
        } catch (cause) {
          throw memorySourceError('source_unavailable', 'delta chain record is invalid', {
            retryable: true,
            cause,
          });
        }
        if (previousDigest !== expectedChainDigest || chainDigest !== computed) {
          throw memorySourceError('source_changed', 'delta chain continuity failed', {
            retryable: true,
          });
        }
        expectedChainDigest = chainDigest;
      }
      imported += 1;
      expectedSequence += 1;
      expectedRevision += 1;
      if (entry.op === 'upsert_node') {
        const id = normalizeId(entry.record?.id);
        if (!id) throw memorySourceError('source_unavailable', 'invalid node delta id', { retryable: true });
        const node = clone({ ...entry.record, id });
        retainedBytes -= upsertBytes.get(id) || 0;
        if (removed.delete(id)) retainedBytes -= Buffer.byteLength(id, 'utf8');
        const bytes = Buffer.byteLength(id, 'utf8') + Buffer.byteLength(JSON.stringify(node), 'utf8');
        upserts.set(id, node);
        upsertBytes.set(id, bytes);
        retainedBytes += bytes;
        if (!changed.has(id)) {
          changed.add(id);
          retainedBytes += Buffer.byteLength(id, 'utf8');
        }
      } else if (entry.op === 'remove_node') {
        const id = normalizeId(entry.id);
        if (!id) throw memorySourceError('source_unavailable', 'invalid node tombstone id', { retryable: true });
        if (upserts.delete(id)) retainedBytes -= upsertBytes.get(id) || 0;
        upsertBytes.delete(id);
        if (!removed.has(id)) {
          removed.add(id);
          retainedBytes += Buffer.byteLength(id, 'utf8');
        }
        if (!changed.has(id)) {
          changed.add(id);
          retainedBytes += Buffer.byteLength(id, 'utf8');
        }
      } else if (entry.op === 'upsert_edge' || entry.op === 'remove_edge') {
        state.edgeOnlyRecords += 1;
      } else {
        throw memorySourceError('source_unavailable', 'invalid delta operation', { retryable: true });
      }
      if (changed.size > maxChangedNodes) {
        throw memorySourceError('result_too_large', 'delta overlay changed-node limit exceeded', {
          status: 413, retryable: false, limit: maxChangedNodes,
        });
      }
      if (retainedBytes > maxRetainedBytes) {
        throw memorySourceError('result_too_large', 'delta overlay retained-byte limit exceeded', {
          status: 413, retryable: false, limit: maxRetainedBytes,
        });
      }
    }
    if (state.deltaRecords + imported !== manifest.activeDelta.count
        || expectedRevision !== manifest.currentRevision + 1) {
      throw memorySourceError('source_unavailable', 'committed delta is incomplete', { retryable: true });
    }
    if (chainAuthority && expectedChainDigest !== manifest.activeDelta.chainDigest) {
      throw memorySourceError('source_changed', 'delta chain watermark differs from manifest', {
        retryable: true,
      });
    }
    state.coveredThroughRevision = manifest.currentRevision;
    state.committedBytes = manifest.activeDelta.committedBytes;
    state.deltaRecords = manifest.activeDelta.count;
    state.upserts = [...upserts.values()];
    state.removedNodeIds = [...removed];
    state.changedNodeIds = [...changed];
    state.fileSignature = signature;
    state.committedPrefixDigest = chainAuthority
      ? manifest.activeDelta.chainDigest
      : (canExtend
        ? crypto.createHash('sha256')
          .update(`home23-delta-chain-v1\0${current.state.committedPrefixDigest}\0${startByte}\0${manifest.activeDelta.committedBytes}\0${rangeDigest}`)
          .digest('hex')
        : rangeDigest);
    state.committedChainDigest = chainAuthority ? manifest.activeDelta.chainDigest : null;
    state.chainBaseCount = chainAuthority ? manifest.activeDelta.chainBaseCount : null;
    state.chainBaseBytes = chainAuthority ? manifest.activeDelta.chainBaseBytes : null;
    state.chainBaseDigest = chainAuthority ? manifest.activeDelta.chainBaseDigest : null;
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    const encodedState = Buffer.from(`${JSON.stringify(state)}\n`);
    if (encodedState.length > maxCacheBytes) {
      throw memorySourceError('result_too_large', 'delta overlay cache file limit exceeded', {
        status: 413, retryable: false, limit: maxCacheBytes,
      });
    }
    await fsp.writeFile(temp, encodedState, { mode: 0o600 });
    await fsp.rename(temp, cachePath);
    const snapshot = snapshotFromState(state, cachePath);
    current = { state, snapshot };
    return snapshot;
  }

  return Object.freeze({
    refresh(input) {
      const run = refreshTail.then(() => refreshNow(input));
      refreshTail = run.catch(() => {});
      return run;
    },
  });
}

module.exports = {
  createMemoryDeltaOverlayCache,
};
