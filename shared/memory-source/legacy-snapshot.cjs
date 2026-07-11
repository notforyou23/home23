'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const { readManifest, writeManifestAtomic, fsyncDirectory } = require('./manifest.cjs');
const {
  assertOpenedFilePathIdentity,
  assertStableOpenedFile,
  openConfinedRegularFile,
  portableFileIdentity,
} = require('./confined-file.cjs');
const {
  canonicalJson,
  memorySourceError,
  rethrowAbort,
  throwIfAborted,
} = require('./contracts.cjs');

function fingerprint(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function quoteKey(key) {
  return JSON.stringify(key);
}

function isBoundaryChar(value) {
  return value === undefined || /[\s:,[\]{}]/.test(value);
}

function findQuotedKey(text, key, from = 0) {
  const needle = quoteKey(key);
  let index = from;
  for (;;) {
    index = text.indexOf(needle, index);
    if (index < 0) return -1;
    if (isBoundaryChar(text[index - 1]) && isBoundaryChar(text[index + needle.length])) return index;
    index += needle.length;
  }
}

function findValueStart(text, key, from = 0) {
  let search = from;
  for (;;) {
    const keyIndex = findQuotedKey(text, key, search);
    if (keyIndex < 0) return -1;
    let index = keyIndex + quoteKey(key).length;
    while (/\s/.test(text[index] || '')) index += 1;
    if (text[index] === ':') {
      index += 1;
      while (/\s/.test(text[index] || '')) index += 1;
      return index;
    }
    search = keyIndex + quoteKey(key).length;
  }
}

function createArrayExtractor({ maxRecordBytes, signal, onRecord }) {
  let active = null;
  let buffer = '';
  let sawMemoryObject = false;
  let memoryObjectStart = 0;
  let done = false;
  const decoder = new StringDecoder('utf8');

  async function consumeActive(char) {
    if (active.mode === 'seek') {
      if (/\s|,/.test(char)) return false;
      if (char === ']') {
        active = null;
        return false;
      }
      active.mode = 'record';
      active.record = '';
      active.depth = 0;
      active.inString = false;
      active.escape = false;
    }
    active.record += char;
    if (Buffer.byteLength(active.record, 'utf8') > maxRecordBytes) {
      throw memorySourceError('result_too_large', 'legacy snapshot record limit exceeded', {
        status: 413,
        retryable: false,
      });
    }
    if (active.inString) {
      if (active.escape) active.escape = false;
      else if (char === '\\') active.escape = true;
      else if (char === '"') active.inString = false;
      return true;
    }
    if (char === '"') active.inString = true;
    else if (char === '{' || char === '[') active.depth += 1;
    else if (char === '}' || char === ']') active.depth -= 1;
    if (active.depth === 0) {
      const parsed = JSON.parse(active.record);
      await onRecord(active.kind, parsed);
      active.mode = 'seek';
      active.record = '';
    }
    return true;
  }

  async function push(chunk) {
    throwIfAborted(signal);
    buffer += decoder.write(chunk);
    for (let index = 0; index < buffer.length; index += 1) {
      throwIfAborted(signal);
      const char = buffer[index];
      if (active) {
        await consumeActive(char);
        continue;
      }
      if (!sawMemoryObject) {
        const memoryStart = findValueStart(buffer, 'memory');
        if (memoryStart < 0 || buffer[memoryStart] !== '{') {
          if (buffer.length > 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
          return;
        }
        sawMemoryObject = true;
        memoryObjectStart = memoryStart;
      }
      for (const kind of ['nodes', 'edges']) {
        const arrayStart = findValueStart(buffer, kind, Math.max(index, memoryObjectStart));
        if (arrayStart >= 0 && buffer[arrayStart] === '[') {
          index = arrayStart;
          active = { kind, mode: 'seek', record: '', depth: 0, inString: false, escape: false };
          break;
        }
      }
      if (!active && sawMemoryObject && findQuotedKey(buffer, 'edges', index) < 0
          && buffer.length > 1024 * 1024) {
        buffer = buffer.slice(-1024 * 1024);
        return;
      }
    }
    if (!active && sawMemoryObject && findQuotedKey(buffer, 'edges') >= 0) done = true;
    if (!active && buffer.length > 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
  }

  async function end() {
    buffer += decoder.end();
    if (active?.mode === 'record') {
      throw memorySourceError('source_unavailable', 'legacy snapshot ended mid-record', { retryable: true });
    }
    return done || sawMemoryObject;
  }

  return { push, end };
}

function createGzipJsonlWriter(filePath, { scratchQuota, signal } = {}) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
  const output = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 });
  gzip.pipe(output);
  let count = 0;
  async function write(record) {
    throwIfAborted(signal);
    const line = `${JSON.stringify(record)}\n`;
    await scratchQuota?.claim?.(Buffer.byteLength(line, 'utf8'), 'legacy_projection');
    if (!gzip.write(line)) await once(gzip, 'drain');
    count += 1;
  }
  async function finish() {
    gzip.end();
    await once(output, 'close');
    const handle = await fsp.open(tmpPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmpPath, filePath);
    return { count, bytes: (await fsp.stat(filePath)).size };
  }
  async function cleanup() {
    gzip.destroy();
    output.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
  return { write, finish, cleanup };
}

async function streamSnapshot({
  stateFile,
  openedFile,
  signal,
  maxDecompressedBytes,
  maxRecordBytes,
  onRecord,
}) {
  const inputBytes = Number(openedFile.stat.size);
  if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) {
    throw memorySourceError('source_unavailable', 'legacy snapshot is empty', { retryable: true });
  }
  const input = fs.createReadStream(null, {
    fd: openedFile.handle.fd,
    autoClose: false,
    start: 0,
    end: inputBytes - 1,
  });
  const decoded = stateFile.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  const hash = crypto.createHash('sha256');
  const extractor = createArrayExtractor({ maxRecordBytes, signal, onRecord });
  let decompressedBytes = 0;
  const abort = () => {
    decoded.destroy(signal.reason);
    input.destroy(signal.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of decoded) {
      throwIfAborted(signal);
      decompressedBytes += chunk.length;
      if (decompressedBytes > maxDecompressedBytes) {
        throw memorySourceError('result_too_large', 'legacy snapshot decompressed limit exceeded', {
          status: 413,
          retryable: false,
        });
      }
      hash.update(chunk);
      await extractor.push(chunk);
    }
    await extractor.end();
    return { sha256: hash.digest('hex'), decompressedBytes };
  } catch (error) {
    rethrowAbort(error, signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function removeOwnedProjectionAttempt(attemptRoot, identity) {
  if (!attemptRoot || !identity) return;
  const stat = await fsp.lstat(attemptRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino) {
    throw memorySourceError(
      'invalid_memory_source',
      'legacy research projection attempt identity changed',
      { retryable: false },
    );
  }
  await fsp.rm(attemptRoot, { recursive: true, force: false });
}

async function digestOpenedRegularFile(root, basename) {
  const opened = await openConfinedRegularFile(root, path.join(root, basename), {
    flags: fs.constants.O_RDONLY,
  });
  try {
    const byteLimit = Number(opened.stat.size);
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) {
      throw memorySourceError('invalid_memory_source', 'published projection file is too large', {
        retryable: false,
      });
    }
    const hash = crypto.createHash('sha256');
    if (byteLimit > 0) {
      const stream = fs.createReadStream(null, {
        fd: opened.handle.fd,
        autoClose: false,
        start: 0,
        end: byteLimit - 1,
      });
      for await (const chunk of stream) hash.update(chunk);
    }
    await assertStableOpenedFile(opened);
    await assertOpenedFilePathIdentity(opened, portableFileIdentity(opened.stat));
    return Object.freeze({ bytes: byteLimit, sha256: hash.digest('hex') });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function validateResearchProjectionWinner({
  projectionRoot,
  attemptRoot,
  expectedManifest,
}) {
  const winnerStat = await fsp.lstat(projectionRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (winnerStat === null || winnerStat.isSymbolicLink() || !winnerStat.isDirectory()
      || await fsp.realpath(projectionRoot) !== projectionRoot) {
    throw memorySourceError('invalid_memory_source', 'legacy research projection winner is unsafe', {
      retryable: false,
    });
  }
  const manifest = await readManifest(projectionRoot);
  if (!manifest || canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    throw memorySourceError(
      'invalid_memory_source',
      'legacy research projection winner manifest differs',
      { retryable: false },
    );
  }
  const files = [
    manifest.activeBase.nodes.file,
    manifest.activeBase.edges.file,
    manifest.activeDelta.file,
    'memory-manifest.json',
  ];
  const entries = (await fsp.readdir(projectionRoot)).sort();
  if (canonicalJson(entries) !== canonicalJson([...files].sort())) {
    throw memorySourceError(
      'invalid_memory_source',
      'legacy research projection winner files differ',
      { retryable: false },
    );
  }
  for (const file of files) {
    const [candidate, winner] = await Promise.all([
      digestOpenedRegularFile(attemptRoot, file),
      digestOpenedRegularFile(projectionRoot, file),
    ]);
    if (candidate.bytes !== winner.bytes || candidate.sha256 !== winner.sha256) {
      throw memorySourceError(
        'invalid_memory_source',
        'legacy research projection winner bytes differ',
        { retryable: false },
      );
    }
  }
  return manifest;
}

function legacyResearchProjectionResult({
  targetRoot,
  projectionRoot,
  manifest,
  sourceFingerprint,
}) {
  return Object.freeze({
    descriptor: Object.freeze({
      version: 1,
      canonicalRoot: targetRoot,
      generation: manifest.generation,
      baseRevision: manifest.baseRevision,
      cutoffRevision: manifest.currentRevision,
      activeBase: manifest.activeBase,
      activeDelta: manifest.activeDelta,
      summary: manifest.summary,
    }),
    projectionRoot,
    manifest,
    sourceFingerprint,
    evidence: Object.freeze({
      sourceHealth: 'degraded',
      matchOutcome: 'unknown',
      freshness: 'unknown',
    }),
  });
}

async function projectLegacyResearchSnapshot({
  canonicalRoot,
  stateFile,
  operationRoot,
  operationId,
  requesterAgent,
  scratchQuota,
  signal,
  maxDecompressedBytes = 2 * 1024 * 1024 * 1024,
  maxRecordBytes = 16 * 1024 * 1024,
  maxAttempts = 3,
  _testHooks = {},
} = {}) {
  throwIfAborted(signal);
  if (!operationId || !requesterAgent) {
    throw memorySourceError('invalid_request', 'operation identity required');
  }
  const targetRoot = await fsp.realpath(canonicalRoot);
  if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)
      || stateFile.includes('\0') || path.normalize(stateFile) !== stateFile) {
    throw memorySourceError('invalid_request', 'absolute normalized state file required');
  }
  const sourceFile = path.join(
    await fsp.realpath(path.dirname(stateFile)),
    path.basename(stateFile),
  );
  const crossing = path.relative(targetRoot, sourceFile);
  if (!crossing || crossing.startsWith('..') || path.isAbsolute(crossing)) {
    throw memorySourceError('invalid_request', 'state file must be inside canonical root');
  }
  const ownsQuota = !scratchQuota;
  const quota = scratchQuota || await createOperationScratchQuota({ operationRoot });
  try {
    const root = quota.operationRoot;
    const projectionsRoot = path.join(root, 'source-projections');
    await fsp.mkdir(projectionsRoot, { recursive: true, mode: 0o700 });
    throwIfAborted(signal);
    let lastMismatch = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      const openedSource = await openConfinedRegularFile(targetRoot, sourceFile, {
        flags: fs.constants.O_RDONLY,
        signal,
      });
      let attemptRoot = null;
      let attemptIdentity = null;
      let nodes = null;
      let edges = null;
      try {
        const before = fingerprint(openedSource.stat);
        attemptRoot = path.join(projectionsRoot, `.attempt-${crypto.randomUUID()}`);
        await fsp.mkdir(attemptRoot, { recursive: false, mode: 0o700 });
        const attemptStat = await fsp.lstat(attemptRoot);
        attemptIdentity = Object.freeze({
          dev: String(attemptStat.dev),
          ino: String(attemptStat.ino),
        });
        throwIfAborted(signal);
      const nodesPath = path.join(attemptRoot, 'memory-nodes.tmp.jsonl.gz');
      const edgesPath = path.join(attemptRoot, 'memory-edges.tmp.jsonl.gz');
      nodes = createGzipJsonlWriter(nodesPath, { scratchQuota: quota, signal });
      edges = createGzipJsonlWriter(edgesPath, { scratchQuota: quota, signal });
      let nodeCount = 0;
      let edgeCount = 0;
      const clusters = new Set();
      const streamed = await streamSnapshot({
        stateFile: sourceFile,
        openedFile: openedSource,
        signal,
        maxDecompressedBytes,
        maxRecordBytes,
        onRecord: async (kind, record) => {
          if (kind === 'nodes') {
            nodeCount += 1;
            if (record?.cluster !== undefined && clusters.size < 100000) clusters.add(String(record.cluster));
            await nodes.write(record);
          } else {
            edgeCount += 1;
            await edges.write(record);
          }
        },
      });
        const nodeFile = await nodes.finish();
        throwIfAborted(signal);
        const edgeFile = await edges.finish();
        throwIfAborted(signal);
        await _testHooks.beforeSourceRecheck?.({ attempt, targetRoot, stateFile: sourceFile });
        throwIfAborted(signal);
        await assertStableOpenedFile(openedSource);
        throwIfAborted(signal);
        await assertOpenedFilePathIdentity(openedSource, portableFileIdentity(openedSource.stat));
        throwIfAborted(signal);
        const revision = Number.parseInt(streamed.sha256.slice(0, 13), 16);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw memorySourceError('invalid_memory_source', 'legacy research revision is invalid', {
            retryable: false,
          });
        }
        const generation = `legacy-${streamed.sha256.slice(0, 20)}`;
        const projectionRoot = path.join(projectionsRoot, generation);
        const nodeBase = `memory-nodes.base-${revision}.jsonl.gz`;
        const edgeBase = `memory-edges.base-${revision}.jsonl.gz`;
        const deltaFile = `memory-delta.e-${revision}.jsonl`;
        await fsp.rename(nodesPath, path.join(attemptRoot, nodeBase));
        throwIfAborted(signal);
        await fsp.rename(edgesPath, path.join(attemptRoot, edgeBase));
        throwIfAborted(signal);
        const deltaHandle = await fsp.open(path.join(attemptRoot, deltaFile), 'wx', 0o600);
        try {
          await deltaHandle.sync();
        } finally {
          await deltaHandle.close();
        }
        throwIfAborted(signal);
        const manifest = {
        formatVersion: 1,
        generation,
        baseRevision: revision,
        currentRevision: revision,
        activeDeltaEpoch: `e-${revision}`,
        activeBase: {
          nodes: { file: nodeBase, count: nodeCount, bytes: nodeFile.bytes },
          edges: { file: edgeBase, count: edgeCount, bytes: edgeFile.bytes },
        },
        activeDelta: {
          epoch: `e-${revision}`,
          file: deltaFile,
          fromRevision: revision + 1,
          toRevision: revision,
          count: 0,
          committedBytes: 0,
        },
        ann: { indexFile: null, metaFile: null, builtFromRevision: revision },
        summary: { nodeCount, edgeCount, clusterCount: clusters.size },
        };
        await writeManifestAtomic(attemptRoot, manifest);
        throwIfAborted(signal);
        await fsyncDirectory(attemptRoot);
        throwIfAborted(signal);
        await assertStableOpenedFile(openedSource);
        throwIfAborted(signal);
        await assertOpenedFilePathIdentity(openedSource, portableFileIdentity(openedSource.stat));
        throwIfAborted(signal);
        let publishedManifest = manifest;
        await quota.withPhysicalGrowth(
          0,
          `legacy_research_publication_${crypto.randomUUID()}`,
          async ({ checkpoint }) => {
            throwIfAborted(signal);
            await assertStableOpenedFile(openedSource);
            throwIfAborted(signal);
            await assertOpenedFilePathIdentity(
              openedSource,
              portableFileIdentity(openedSource.stat),
            );
            throwIfAborted(signal);
            try {
              await fsp.rename(attemptRoot, projectionRoot);
              attemptRoot = null;
              attemptIdentity = null;
              await fsyncDirectory(projectionsRoot);
            } catch (error) {
              if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
              publishedManifest = await validateResearchProjectionWinner({
                projectionRoot,
                attemptRoot,
                expectedManifest: manifest,
              });
              throwIfAborted(signal);
              await removeOwnedProjectionAttempt(attemptRoot, attemptIdentity);
              attemptRoot = null;
              attemptIdentity = null;
            }
            await checkpoint();
          },
        );
        return legacyResearchProjectionResult({
          targetRoot,
          projectionRoot,
          manifest: publishedManifest,
          sourceFingerprint: before,
        });
      } catch (error) {
        await nodes?.cleanup?.().catch(() => {});
        await edges?.cleanup?.().catch(() => {});
        await removeOwnedProjectionAttempt(attemptRoot, attemptIdentity).catch(() => {});
        rethrowAbort(error, signal);
        if (error?.code === 'source_changed') {
          lastMismatch = error;
          continue;
        }
        throw error;
      } finally {
        await openedSource.handle.close().catch(() => {});
      }
    }
    throw lastMismatch || memorySourceError('source_changed', 'legacy snapshot changed during projection', {
      retryable: true,
    });
  } finally {
    if (ownsQuota) await quota.close();
  }
}

module.exports = {
  projectLegacyResearchSnapshot,
};
