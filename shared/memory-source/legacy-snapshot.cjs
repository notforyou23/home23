'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const { writeManifestAtomic, fsyncDirectory } = require('./manifest.cjs');
const { memorySourceError, rethrowAbort, throwIfAborted } = require('./contracts.cjs');

function fingerprint(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameFingerprint(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
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

async function streamSnapshot({ stateFile, signal, maxDecompressedBytes, maxRecordBytes, onRecord }) {
  const input = fs.createReadStream(stateFile);
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
} = {}) {
  throwIfAborted(signal);
  if (!operationId || !requesterAgent) {
    throw memorySourceError('invalid_request', 'operation identity required');
  }
  const targetRoot = await fsp.realpath(canonicalRoot);
  const sourceFile = await fsp.realpath(stateFile);
  if (!sourceFile.startsWith(`${targetRoot}${path.sep}`)) {
    throw memorySourceError('invalid_request', 'state file must be inside canonical root');
  }
  const quota = scratchQuota || await createOperationScratchQuota({ operationRoot });
  const root = quota.operationRoot;
  const projectionsRoot = path.join(root, 'source-projections');
  await fsp.mkdir(projectionsRoot, { recursive: true, mode: 0o700 });
  let lastMismatch = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const before = fingerprint(await fsp.stat(sourceFile, { bigint: true }));
    const attemptRoot = path.join(projectionsRoot, `attempt-${process.pid}-${Date.now()}-${attempt}`);
    await fsp.mkdir(attemptRoot, { recursive: false, mode: 0o700 });
    const nodesPath = path.join(attemptRoot, 'memory-nodes.tmp.jsonl.gz');
    const edgesPath = path.join(attemptRoot, 'memory-edges.tmp.jsonl.gz');
    const nodes = createGzipJsonlWriter(nodesPath, { scratchQuota: quota, signal });
    const edges = createGzipJsonlWriter(edgesPath, { scratchQuota: quota, signal });
    let nodeCount = 0;
    let edgeCount = 0;
    const clusters = new Set();
    try {
      const streamed = await streamSnapshot({
        stateFile: sourceFile,
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
      const edgeFile = await edges.finish();
      const after = fingerprint(await fsp.stat(sourceFile, { bigint: true }));
      if (!sameFingerprint(before, after)) {
        lastMismatch = memorySourceError('source_changed', 'legacy snapshot changed during projection', {
          retryable: true,
        });
        await fsp.rm(attemptRoot, { recursive: true, force: true });
        continue;
      }
      const revision = Number.parseInt(streamed.sha256.slice(0, 13), 16);
      const generation = `legacy-${streamed.sha256.slice(0, 20)}`;
      const projectionRoot = path.join(projectionsRoot, generation);
      await fsp.rm(projectionRoot, { recursive: true, force: true });
      await fsp.mkdir(projectionRoot, { recursive: false, mode: 0o700 });
      const nodeBase = `memory-nodes.base-${revision}.jsonl.gz`;
      const edgeBase = `memory-edges.base-${revision}.jsonl.gz`;
      const deltaFile = `memory-delta.e-${revision}.jsonl`;
      await fsp.rename(nodesPath, path.join(projectionRoot, nodeBase));
      await fsp.rename(edgesPath, path.join(projectionRoot, edgeBase));
      await fsp.writeFile(path.join(projectionRoot, deltaFile), '');
      await fsyncDirectory(projectionRoot);
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
      await writeManifestAtomic(projectionRoot, manifest);
      await fsp.rm(attemptRoot, { recursive: true, force: true }).catch(() => {});
      return Object.freeze({
        descriptor: Object.freeze({
          version: 1,
          canonicalRoot: targetRoot,
          generation,
          baseRevision: revision,
          cutoffRevision: revision,
          activeBase: manifest.activeBase,
          activeDelta: manifest.activeDelta,
          summary: manifest.summary,
        }),
        projectionRoot,
        manifest,
        sourceFingerprint: before,
        evidence: Object.freeze({
          sourceHealth: 'degraded',
          matchOutcome: 'unknown',
          freshness: 'unknown',
        }),
      });
    } catch (error) {
      await nodes.cleanup().catch(() => {});
      await edges.cleanup().catch(() => {});
      await fsp.rm(attemptRoot, { recursive: true, force: true }).catch(() => {});
      rethrowAbort(error, signal);
      throw error;
    }
  }
  throw lastMismatch || memorySourceError('source_changed', 'legacy snapshot changed during projection', {
    retryable: true,
  });
}

module.exports = {
  projectLegacyResearchSnapshot,
};
