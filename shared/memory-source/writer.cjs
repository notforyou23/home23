'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonlGzAtomic, limitError, readJsonl } = require('./jsonl.cjs');
const { readManifest, writeManifestAtomic, fsyncDirectory } = require('./manifest.cjs');
const {
  openConfinedRegularFile,
  portableFileIdentity,
  assertOpenedFilePathIdentity,
} = require('./confined-file.cjs');
const {
  withMemorySourceLock,
  discoverOperationPinFiles,
  readDiscoveredOperationPinRecord,
} = require('./pins.cjs');
const {
  memorySourceError,
  sourceDescriptorDigest,
  throwIfAborted,
} = require('./contracts.cjs');
const { emptyDeltaDigest, nextDeltaChainDigest } = require('./delta-chain.cjs');
const { createDescriptor } = require('./descriptor.cjs');

async function inject(options, point) {
  if (options.faultAt === point) throw new Error(`injected:${point}`);
  await options._testHooks?.[point]?.();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateScalarSummaryOnly(summary) {
  if (!summary || Object.keys(summary).sort().join(',') !== 'clusterCount,edgeCount,nodeCount') {
    throw memorySourceError('invalid_request', 'scalar summary required');
  }
  const copy = {};
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
      throw memorySourceError('invalid_request', 'invalid scalar summary');
    }
    copy[field] = summary[field];
  }
  return Object.freeze(copy);
}

function normalizeCapturedChanges(changes = {}) {
  const copy = {};
  let count = 0;
  let bytes = 0;
  for (const key of ['nodes', 'edges', 'removedNodeIds', 'removedEdgeKeys']) {
    const rows = Array.isArray(changes[key]) ? changes[key] : [];
    copy[key] = rows.map((row) => {
      const cloned = cloneJson(row);
      const encodedBytes = Buffer.byteLength(JSON.stringify(cloned), 'utf8');
      if (encodedBytes > 16 * 1024 * 1024) throw limitError('delta_record', 16 * 1024 * 1024);
      count += 1;
      bytes += encodedBytes;
      if (count > 100000 || bytes > 512 * 1024 * 1024) {
        throw limitError('delta_commit', 512 * 1024 * 1024);
      }
      return cloned;
    });
  }
  return Object.freeze(copy);
}

function* changeRecords(changes) {
  for (const record of changes.nodes) yield { op: 'upsert_node', record };
  for (const record of changes.edges) yield { op: 'upsert_edge', record };
  for (const id of changes.removedNodeIds) yield { op: 'remove_node', id };
  for (const key of changes.removedEdgeKeys) yield { op: 'remove_edge', key };
}

function countChanges(changes) {
  return changes.nodes.length + changes.edges.length
    + changes.removedNodeIds.length + changes.removedEdgeKeys.length;
}

function committedFileIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameCommittedContent(stat, identity) {
  return Boolean(identity
    && String(stat.dev) === identity.dev
    && String(stat.ino) === identity.ino
    && String(stat.size) === identity.size
    && String(stat.mtimeNs) === identity.mtimeNs
    && String(stat.ctimeNs) === identity.ctimeNs);
}

async function hashOpenedPrefix(handle, endByte, signal) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < endByte) {
    throwIfAborted(signal);
    const read = await handle.read(chunk, 0, Math.min(chunk.length, endByte - position), position);
    if (read.bytesRead <= 0) {
      throw memorySourceError('source_unavailable', 'committed delta prefix is truncated', {
        retryable: true,
      });
    }
    hash.update(chunk.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash.digest('hex');
}

async function validateCommittedDeltaChain(brainDir, deltaPath, opened, manifest, signal) {
  const activeDelta = manifest.activeDelta;
  const baseDigest = await hashOpenedPrefix(opened.handle, activeDelta.chainBaseBytes, signal);
  if (baseDigest !== activeDelta.chainBaseDigest) {
    throw memorySourceError('source_changed', 'delta chain base differs from manifest', {
      retryable: true,
    });
  }
  let expectedSequence = 1;
  let expectedRevision = manifest.baseRevision + 1;
  let chainDigest = activeDelta.chainBaseDigest;
  for await (const entry of readJsonl(deltaPath, {
    confinedRoot: brainDir,
    byteLimit: activeDelta.committedBytes,
    requireCompletePrefix: true,
    allowTrailingBytes: true,
    expectedRecordCount: activeDelta.count,
    signal,
  })) {
    throwIfAborted(signal);
    if (entry?.epoch !== manifest.activeDeltaEpoch
        || entry.sequence !== expectedSequence
        || entry.revision !== expectedRevision) {
      throw memorySourceError('source_changed', 'committed delta chain range is invalid', {
        retryable: true,
      });
    }
    if (entry.sequence > activeDelta.chainBaseCount) {
      const { previousDigest, chainDigest: recordDigest, ...payload } = entry;
      let computed;
      try {
        computed = nextDeltaChainDigest(chainDigest, payload);
      } catch (cause) {
        throw memorySourceError('source_changed', 'committed delta chain record is invalid', {
          retryable: true,
          cause,
        });
      }
      if (previousDigest !== chainDigest || recordDigest !== computed) {
        throw memorySourceError('source_changed', 'committed delta chain continuity failed', {
          retryable: true,
        });
      }
      chainDigest = recordDigest;
    }
    expectedSequence += 1;
    expectedRevision += 1;
  }
  if (expectedSequence !== activeDelta.count + 1
      || expectedRevision !== manifest.currentRevision + 1
      || chainDigest !== activeDelta.chainDigest) {
    throw memorySourceError('source_changed', 'committed delta chain watermark differs from manifest', {
      retryable: true,
    });
  }
}

async function writeAllAt(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw memorySourceError('source_unavailable', 'delta write made no progress', {
        retryable: true,
      });
    }
    written += result.bytesWritten;
  }
}

async function appendMemoryRevision(brainDir, changes, options = {}) {
  const capturedChanges = normalizeCapturedChanges(changes);
  const capturedSummary = options.summary ? validateScalarSummaryOnly(options.summary) : null;
  await options.beforeLock?.();
  return withMemorySourceLock(brainDir, {
    lockRoot: options.lockRoot,
    signal: options.signal,
    lockTimeoutMs: options.lockTimeoutMs,
  }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest) throw memorySourceError('source_unavailable', 'memory manifest required', { retryable: true });
    const deltaPath = path.join(brainDir, manifest.activeDelta.file);
    const committedBytes = manifest.activeDelta.committedBytes;
    const opened = await openConfinedRegularFile(brainDir, deltaPath, {
      flags: fs.constants.O_RDWR,
    });
    const openedIdentity = portableFileIdentity(opened.stat);
    let revision = manifest.currentRevision;
    let sequence = manifest.activeDelta.count;
    let offset = committedBytes;
    try {
      const appendFromStat = await opened.handle.stat({ bigint: true });
      if (Number(appendFromStat.size) < committedBytes) {
        throw memorySourceError('source_unavailable', 'committed delta is truncated', { retryable: true });
      }
      const preOpenIdentity = opened.pathIdentity || appendFromStat;
      const cleanCommittedSize = Number(preOpenIdentity.size) === committedBytes;
      const hasChainAuthority = typeof manifest.activeDelta.chainDigest === 'string';
      if (cleanCommittedSize && manifest.activeDelta.fileIdentity
          && !sameCommittedContent(preOpenIdentity, manifest.activeDelta.fileIdentity)) {
        throw memorySourceError('source_changed', 'delta differs from committed manifest identity', {
          retryable: true,
        });
      }
      if (hasChainAuthority && (!cleanCommittedSize || !manifest.activeDelta.fileIdentity)) {
        await validateCommittedDeltaChain(
          brainDir,
          deltaPath,
          opened,
          manifest,
          options.signal,
        );
      }
      await assertOpenedFilePathIdentity(opened, openedIdentity);
      if (Number(appendFromStat.size) !== committedBytes) {
        await opened.handle.truncate(committedBytes);
      }
      const committedPrefixStat = await opened.handle.stat({ bigint: true });
      const appendFrom = {
        committedBytes,
        count: manifest.activeDelta.count,
        fileIdentity: cleanCommittedSize && manifest.activeDelta.fileIdentity
          || committedFileIdentity(committedPrefixStat),
      };
      const chainBaseCount = hasChainAuthority
        ? manifest.activeDelta.chainBaseCount
        : manifest.activeDelta.count;
      const chainBaseBytes = hasChainAuthority
        ? manifest.activeDelta.chainBaseBytes
        : committedBytes;
      const chainBaseDigest = hasChainAuthority
        ? manifest.activeDelta.chainBaseDigest
        : await hashOpenedPrefix(opened.handle, committedBytes, options.signal);
      let chainDigest = hasChainAuthority
        ? manifest.activeDelta.chainDigest
        : chainBaseDigest;
      for (const record of changeRecords(capturedChanges)) {
        revision += 1;
        sequence += 1;
        const payload = {
          epoch: manifest.activeDeltaEpoch,
          sequence,
          revision,
          ...record,
        };
        const previousDigest = chainDigest;
        chainDigest = nextDeltaChainDigest(previousDigest, payload);
        const encoded = Buffer.from(`${JSON.stringify({
          ...payload,
          previousDigest,
          chainDigest,
        })}\n`);
        await writeAllAt(opened.handle, encoded, offset);
        offset += encoded.length;
      }
      await opened.handle.sync();
      await inject(options, 'afterDeltaFsync');
      const bytes = offset;
      const committedStat = await opened.handle.stat({ bigint: true });
      if (Number(committedStat.size) !== bytes) {
        throw memorySourceError('source_changed', 'delta committed size changed', {
          retryable: true,
        });
      }
      const committedIdentity = portableFileIdentity(committedStat);
      await assertOpenedFilePathIdentity(opened, committedIdentity);
      const next = {
        ...manifest,
        currentRevision: revision,
        activeDelta: {
          ...manifest.activeDelta,
          toRevision: revision,
          count: sequence,
          committedBytes: bytes,
          appendFrom,
          fileIdentity: committedFileIdentity(committedStat),
          chainBaseCount,
          chainBaseBytes,
          chainBaseDigest,
          chainDigest,
        },
        summary: capturedSummary || manifest.summary,
      };
      await inject(options, 'beforeManifestRename');
      await assertOpenedFilePathIdentity(opened, committedIdentity);
      await writeManifestAtomic(brainDir, next);
      const recordCount = countChanges(capturedChanges);
      return Object.freeze({
        epoch: next.activeDeltaEpoch,
        fromRevision: manifest.currentRevision + (recordCount ? 1 : 0),
        toRevision: revision,
        count: recordCount,
        bytes,
        manifest: next,
      });
    } finally {
      await opened.handle.close();
    }
  });
}

function normalizeCapturedView(input) {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw memorySourceError('invalid_request', 'immutable captured view required');
  }
  const nodes = input.nodes.map(cloneJson);
  const edges = input.edges.map(cloneJson);
  const summary = validateScalarSummaryOnly(input.summary);
  if (summary.nodeCount !== nodes.length || summary.edgeCount !== edges.length
      || summary.clusterCount > summary.nodeCount) {
    throw memorySourceError('invalid_request', 'captured summary mismatch');
  }
  return Object.freeze({
    nodes: Object.freeze(nodes.map(Object.freeze)),
    edges: Object.freeze(edges.map(Object.freeze)),
    summary,
  });
}

async function rewriteMemoryBase(brainDir, capturedView, options = {}) {
  const view = normalizeCapturedView(capturedView);
  await options.beforeLock?.();
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const previous = await readManifest(brainDir);
    const baseRevision = (previous?.currentRevision || 0) + 1;
    const generation = `g-${baseRevision}-${randomUUID()}`;
    const epoch = `e-${baseRevision + 1}-${randomUUID()}`;
    const nodeFile = `memory-nodes.base-${baseRevision}.jsonl.gz`;
    const edgeFile = `memory-edges.base-${baseRevision}.jsonl.gz`;
    const deltaFile = `memory-delta.${epoch}.jsonl`;
    const nodes = await writeJsonlGzAtomic(path.join(brainDir, nodeFile), view.nodes, options);
    const edges = await writeJsonlGzAtomic(path.join(brainDir, edgeFile), view.edges, options);
    const deltaHandle = await fsp.open(path.join(brainDir, deltaFile), 'wx', 0o600);
    await deltaHandle.sync();
    const deltaStat = await deltaHandle.stat({ bigint: true });
    await deltaHandle.close();
    await fsyncDirectory(brainDir);
    await inject(options, 'afterBaseFiles');
    const manifest = {
      formatVersion: 1,
      generation,
      baseRevision,
      currentRevision: baseRevision,
      activeDeltaEpoch: epoch,
      activeBase: {
        nodes: { file: nodeFile, count: nodes.count, bytes: nodes.bytes },
        edges: { file: edgeFile, count: edges.count, bytes: edges.bytes },
      },
      activeDelta: {
        epoch,
        file: deltaFile,
        fromRevision: baseRevision + 1,
        toRevision: baseRevision,
        count: 0,
        committedBytes: 0,
        fileIdentity: committedFileIdentity(deltaStat),
        chainBaseCount: 0,
        chainBaseBytes: 0,
        chainBaseDigest: emptyDeltaDigest(),
        chainDigest: emptyDeltaDigest(),
      },
      ann: { indexFile: null, metaFile: null, builtFromRevision: null },
      summary: view.summary,
    };
    await inject(options, 'beforeManifestRename');
    await writeManifestAtomic(brainDir, manifest);
    return Object.freeze({ baseRevision, deltaEpoch: epoch, nodes, edges, manifest });
  });
}

async function advanceAnnBuiltFromRevision(brainDir, update = {}) {
  let completedOutcome = null;
  try {
    return await withMemorySourceLock(brainDir, {
      lockRoot: update.lockRoot,
      signal: update.signal,
      lockTimeoutMs: update.lockTimeoutMs,
      _testHooks: update._testHooks,
    }, async () => {
      const manifest = await readManifest(brainDir);
      if (!manifest || manifest.generation !== update.expectedGeneration) {
        return { advanced: false, reason: 'source_changed', manifest };
      }
      if (!Number.isSafeInteger(update.builtFromRevision) || update.builtFromRevision < 0) {
        throw memorySourceError('invalid_request', 'invalid ANN revision');
      }
      const bridgeAuthoritySupplied = Number.isSafeInteger(update.expectedBaseRevision)
        && typeof update.expectedDeltaEpoch === 'string'
        && update.expectedDeltaEpoch.length > 0;
      if (bridgeAuthoritySupplied
          && (manifest.baseRevision !== update.expectedBaseRevision
            || manifest.activeDeltaEpoch !== update.expectedDeltaEpoch)) {
        return { advanced: false, reason: 'source_changed', manifest };
      }
      if (Number.isSafeInteger(manifest.ann?.builtFromRevision)
          && manifest.ann.builtFromRevision > update.builtFromRevision) {
        return { advanced: false, reason: 'ann_regression', manifest };
      }
      const bridgeable = update.builtFromRevision >= manifest.baseRevision
        && update.builtFromRevision <= manifest.currentRevision
        && manifest.activeDelta.fromRevision === manifest.baseRevision + 1
        && manifest.activeDelta.toRevision === manifest.currentRevision
        && manifest.activeDelta.count === manifest.currentRevision - manifest.baseRevision;
      if (!bridgeable
          || (update.builtFromRevision !== manifest.currentRevision && !bridgeAuthoritySupplied)) {
        return { advanced: false, reason: 'source_changed', manifest };
      }
      let expectedSequence = 1;
      let expectedRevision = manifest.baseRevision + 1;
      for await (const entry of readJsonl(path.join(brainDir, manifest.activeDelta.file), {
        confinedRoot: brainDir,
        byteLimit: manifest.activeDelta.committedBytes,
        requireCompletePrefix: true,
        allowTrailingBytes: true,
        expectedRecordCount: manifest.activeDelta.count,
        signal: update.signal,
      })) {
        if (entry?.epoch !== manifest.activeDeltaEpoch
            || entry.sequence !== expectedSequence
            || entry.revision !== expectedRevision) {
          throw memorySourceError('source_unavailable', 'ANN delta bridge records are not contiguous', {
            retryable: true,
          });
        }
        expectedSequence += 1;
        expectedRevision += 1;
      }
      if (expectedSequence !== manifest.activeDelta.count + 1
          || expectedRevision !== manifest.currentRevision + 1) {
        throw memorySourceError('source_unavailable', 'ANN delta bridge is incomplete', {
          retryable: true,
        });
      }
      const next = {
        ...manifest,
        ann: {
          indexFile: update.indexFile,
          metaFile: update.metaFile,
          builtFromRevision: update.builtFromRevision,
        },
      };
      await writeManifestAtomic(brainDir, next);
      completedOutcome = {
        advanced: true,
        coverage: update.builtFromRevision === manifest.currentRevision ? 'fresh' : 'overlay-covered',
        manifest: next,
      };
      return completedOutcome;
    });
  } catch (error) {
    if (completedOutcome && error?.sourceLockReleased === true) return completedOutcome;
    throw error;
  }
}

async function compareAndSwapSourceRevision(brainDir, update = {}) {
  if (typeof update.expectedGeneration !== 'string' || update.expectedGeneration.length === 0
      || !Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0
      || typeof update.expectedDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(update.expectedDigest)
      || typeof update.commit !== 'function'
      || (update.authorize !== undefined && typeof update.authorize !== 'function')) {
    throw memorySourceError('invalid_request', 'exact source CAS contract required');
  }
  throwIfAborted(update.signal);
  let completedOutcome = null;
  try {
    return await withMemorySourceLock(brainDir, {
      lockRoot: update.lockRoot,
      signal: update.signal,
      _testHooks: update._testHooks,
    }, async () => {
      throwIfAborted(update.signal);
      const manifest = await readManifest(brainDir);
      const descriptor = manifest
        ? createDescriptor(await fsp.realpath(brainDir), manifest)
        : null;
      if (!manifest || manifest.generation !== update.expectedGeneration
          || manifest.currentRevision !== update.expectedRevision
          || sourceDescriptorDigest(descriptor) !== update.expectedDigest) {
        return { committed: false, reason: 'source_changed', manifest };
      }
      if (update.authorize) await update.authorize();
      throwIfAborted(update.signal);
      const value = await update.commit();
      completedOutcome = { committed: true, manifest, value };
      return completedOutcome;
    });
  } catch (error) {
    // A completed callback is the logical commit point. Cancellation or lock
    // observer failure after proved release cannot turn that commit into
    // failure. Ownership, identity, or release failures still fail closed so
    // recovery reconciles the durable claim and committed bytes explicitly.
    if (completedOutcome && error?.sourceLockReleased === true) return completedOutcome;
    throw error;
  }
}

async function retireUnpinnedSources(brainDir, options = {}) {
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest) return { retired: [], retained: [], reason: 'manifest_missing' };
    const pinEntries = options.pinFiles || (options.home23Root
      ? await discoverOperationPinFiles(options.home23Root)
      : []);
    const protectedFiles = new Set([
      'memory-manifest.json',
      manifest.activeBase.nodes.file,
      manifest.activeBase.edges.file,
      manifest.activeDelta.file,
      manifest.ann.indexFile,
      manifest.ann.metaFile,
    ].filter(Boolean));
    for (const entry of pinEntries) {
      const record = await readDiscoveredOperationPinRecord(entry);
      if (record.canonicalRoot !== await fsp.realpath(brainDir)) continue;
      for (const file of record.files || record.protectedFiles || []) protectedFiles.add(file);
    }
    const retired = [];
    const retained = [];
    for (const name of await fsp.readdir(brainDir)) {
      if (!/^memory-(nodes|edges)\.base-|^memory-delta\.|^memory-ann\./.test(name)) continue;
      if (protectedFiles.has(name)) retained.push(name);
      else {
        await fsp.rm(path.join(brainDir, name), { force: true });
        retired.push(name);
      }
    }
    return { retired: retired.sort(), retained: retained.sort() };
  });
}

module.exports = {
  appendMemoryRevision,
  rewriteMemoryBase,
  advanceAnnBuiltFromRevision,
  compareAndSwapSourceRevision,
  retireUnpinnedSources,
  normalizeCapturedView,
};
