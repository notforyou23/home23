/**
 * Memory sidecar — gzipped JSONL files for memory.nodes and memory.edges.
 *
 * Why this exists: V8 has a hard max string length of ~536 MB. Once the
 * full brain state (nodes + edges + everything) exceeded that decompressed
 * size, `JSON.parse`/`JSON.stringify` silently failed and the engine
 * booted as a fresh brain on every restart — destroying the live graph.
 *
 * Solution: serialize the two biggest arrays (nodes, edges) as line-
 * delimited JSON, streamed through gzip. Each record is parsed/serialized
 * individually, so the single-string limit never applies regardless of
 * graph size. A 10M-node brain works exactly the same as a 1K-node brain.
 *
 * File names:
 *   memory-nodes.jsonl.gz   one node per line
 *   memory-edges.jsonl.gz   one edge per line
 *
 * Compatibility: on load, prefer sidecars if present, fall back to the
 * monolithic state.json.gz otherwise. This allows live migration without
 * losing brains that predate the split.
 *
 * Integrity: file sizes + line counts are recorded in brain-snapshot.json
 * so the loader can fail loudly if a sidecar is truncated or missing.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline, Readable, Transform } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);
const {
  appendMemoryRevision,
  openMemorySource,
  readJsonl,
  readManifest,
  rewriteMemoryBase,
  withMemorySourceLock,
} = require('../../../shared/memory-source');

const NODES_FILE = 'memory-nodes.jsonl.gz';
const EDGES_FILE = 'memory-edges.jsonl.gz';
const MEMORY_DELTA_FILE = 'memory-delta.jsonl';
const DEFAULT_GZIP_LEVEL = zlib.constants.Z_BEST_SPEED;

function nodesPath(brainDir) { return path.join(brainDir, NODES_FILE); }
function edgesPath(brainDir) { return path.join(brainDir, EDGES_FILE); }
function memoryDeltaPath(brainDir) { return path.join(brainDir, MEMORY_DELTA_FILE); }

function serializeNodeRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const embedding = record.embedding;
  if (embedding && !Array.isArray(embedding) && ArrayBuffer.isView(embedding) && typeof embedding.length === 'number') {
    return { ...record, embedding: Array.from(embedding) };
  }
  return record;
}

function uniqueTmpPath(outPath) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return `${outPath}.${suffix}.tmp`;
}

/**
 * Stream-write an array of records as gzipped JSONL to a tmp file, then
 * atomically rename into place. Never constructs a full-array string.
 *
 * @param {string} outPath    final output path (will write .tmp first)
 * @param {Iterable<any>} records
 * @param {{level?: number}} options
 * @returns {Promise<{count:number, bytes:number}>}
 */
async function writeJsonlGz(outPath, records, options = {}) {
  const tmpPath = uniqueTmpPath(outPath);
  const level = Number.isInteger(options.level) ? options.level : DEFAULT_GZIP_LEVEL;
  const gz = zlib.createGzip({ level });
  const sink = fs.createWriteStream(tmpPath);

  let count = 0;

  // Push records through the gzip stream one at a time. Using a Readable
  // in flowing mode would buffer; instead we iterate ourselves and write.
  gz.pipe(sink);

  const drain = (stream) => new Promise(r => stream.once('drain', r));

  try {
    for (const rec of records) {
      const line = JSON.stringify(rec) + '\n';
      if (!gz.write(line)) await drain(gz);
      count++;
    }

    // Flush and wait for sink to finish. Register sink listeners before
    // calling gz.end(); otherwise a fast close can happen before the end
    // callback attaches its listener and leave saveState hung with a .tmp file.
    await new Promise((resolve, reject) => {
      sink.once('close', resolve);
      sink.once('error', reject);
      gz.once('error', reject);
      gz.end();
    });

    const bytes = fs.statSync(tmpPath).size;
    fs.renameSync(tmpPath, outPath);
    return { count, bytes };
  } catch (error) {
    try { gz.destroy(); } catch {}
    try { sink.destroy(); } catch {}
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Stream-read a gzipped JSONL file, yielding parsed records. No full-file
 * read into memory.
 *
 * @param {string} inPath
 * @param {(rec:any, lineNo:number) => void | boolean} onRecord
 *   Return false to stop iteration.
 * @returns {Promise<{count:number, parseErrors:number}>}
 */
async function readJsonlGz(inPath, onRecord) {
  if (!fs.existsSync(inPath)) {
    return { count: 0, parseErrors: 0 };
  }
  const source = fs.createReadStream(inPath);
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: source.pipe(gunzip) });

  let count = 0;
  let parseErrors = 0;
  let stopped = false;

  for await (const line of rl) {
    if (stopped) break;
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      const cont = onRecord(rec, count);
      count++;
      if (cont === false) stopped = true;
    } catch {
      parseErrors++;
    }
  }

  return { count, parseErrors };
}

/**
 * Write both sidecars for a memory object. Returns counts + sizes for the
 * brain-snapshot record.
 */
async function writeMemorySidecars(brainDir, memory, options = {}) {
  const snapshot = memory?.capturePersistenceSnapshot?.();
  const view = snapshot ? {
    nodes: snapshot.fullView.nodes,
    edges: snapshot.fullView.edges,
    summary: snapshot.summary,
  } : captureCompatibilityView(memory);
  const result = await rewriteMemoryBase(brainDir, view, {
    ...options,
    lockRoot: options.lockRoot || defaultSidecarLockRoot(brainDir),
  });
  try { fs.rmSync(memoryDeltaPath(brainDir), { force: true }); } catch {}
  return {
    mode: 'full',
    revision: result.manifest.currentRevision,
    manifest: result.manifest,
    nodes: {
      file: result.manifest.activeBase.nodes.file,
      count: result.manifest.activeBase.nodes.count,
      bytes: result.manifest.activeBase.nodes.bytes,
    },
    edges: {
      file: result.manifest.activeBase.edges.file,
      count: result.manifest.activeBase.edges.count,
      bytes: result.manifest.activeBase.edges.bytes,
    },
  };
}

async function appendMemoryDelta(brainDir, changes = {}, options = {}) {
  const lockRoot = options.lockRoot || defaultSidecarLockRoot(brainDir);
  const manifest = await readManifest(brainDir);
  if (manifest) {
    const result = await appendMemoryRevision(brainDir, normalizeCompatibilityChanges(changes), {
      lockRoot,
      summary: changes.summary || manifest.summary,
      signal: options.signal,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    return { count: result.count, bytes: result.bytes, manifest: result.manifest };
  }
  const p = memoryDeltaPath(brainDir);
  const hasChanges = Boolean(
    (changes.nodes || []).length ||
    (changes.edges || []).length ||
    (changes.removedNodeIds || []).length ||
    (changes.removedEdgeKeys || []).length
  );
  const normalized = normalizeCompatibilityChanges(changes);
  const entries = function* deltaEntries() {
    for (const node of normalized.nodes) {
      yield { op: 'upsert_node', record: serializeNodeRecord(node) };
    }
    for (const edge of normalized.edges) {
      yield { op: 'upsert_edge', record: edge };
    }
    for (const id of normalized.removedNodeIds) {
      yield { op: 'remove_node', id };
    }
    for (const key of normalized.removedEdgeKeys) {
      yield { op: 'remove_edge', key };
    }
  };

  await fs.promises.mkdir(brainDir, { recursive: true });
  await options.beforeLock?.();
  const legacyResult = await withMemorySourceLock(brainDir, {
    lockRoot,
    signal: options.signal,
    lockTimeoutMs: options.lockTimeoutMs ?? 30 * 60 * 1000,
    _testHooks: options._testHooks,
  }, async () => {
    // A first safe rewrite can publish manifest-v1 while an engine save is
    // waiting. Re-read authority only after owning the same external lock so
    // the save cannot append to the retired legacy journal after cutover.
    const lockedManifest = await readManifest(brainDir);
    if (lockedManifest) return { route: 'manifest', manifest: lockedManifest };
    if (!hasChanges) {
      return { route: 'legacy', count: 0, bytes: fs.existsSync(p) ? fs.statSync(p).size : 0 };
    }

    const handle = await fs.promises.open(p, 'a', 0o600);
    let count = 0;
    try {
      for (const entry of entries()) {
        await handle.write(`${JSON.stringify(entry)}\n`, null, 'utf8');
        count++;
      }
      await handle.sync();
      const stat = await handle.stat();
      return { route: 'legacy', count, bytes: stat.size };
    } finally {
      await handle.close();
    }
  });

  if (legacyResult.route === 'manifest') {
    const result = await appendMemoryRevision(brainDir, normalized, {
      lockRoot,
      summary: changes.summary || legacyResult.manifest.summary,
      signal: options.signal,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    return { count: result.count, bytes: result.bytes, manifest: result.manifest };
  }
  return { count: legacyResult.count, bytes: legacyResult.bytes };
}

async function readMemoryDeltas(brainDir, handlers = {}) {
  const manifest = await readManifest(brainDir).catch(() => null);
  if (manifest) {
    let count = 0;
    let parseErrors = 0;
    try {
      for await (const entry of readJsonl(path.join(brainDir, manifest.activeDelta.file), {
        confinedRoot: brainDir,
        byteLimit: manifest.activeDelta.committedBytes,
        requireCompletePrefix: true,
      })) {
        if (entry.op === 'upsert_node') handlers.onNode?.(entry.record);
        else if (entry.op === 'upsert_edge') handlers.onEdge?.(entry.record);
        else if (entry.op === 'remove_node') handlers.onRemoveNode?.(entry.id);
        else if (entry.op === 'remove_edge') handlers.onRemoveEdge?.(entry.key);
        count++;
      }
    } catch {
      parseErrors++;
    }
    return { count, parseErrors };
  }
  const p = memoryDeltaPath(brainDir);
  if (!fs.existsSync(p)) {
    return { count: 0, parseErrors: 0 };
  }

  const source = fs.createReadStream(p, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: source, crlfDelay: Infinity });
  let count = 0;
  let parseErrors = 0;

  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.op === 'upsert_node') {
        handlers.onNode?.(entry.record);
      } else if (entry.op === 'upsert_edge') {
        handlers.onEdge?.(entry.record);
      } else if (entry.op === 'remove_node') {
        handlers.onRemoveNode?.(entry.id);
      } else if (entry.op === 'remove_edge') {
        handlers.onRemoveEdge?.(entry.key);
      }
      count++;
    } catch {
      parseErrors++;
    }
  }

  return { count, parseErrors };
}

/**
 * Read both sidecars and pump each record into the provided memory via
 * addNode / addEdge callbacks. The loader owns construction of the Map
 * structures; this module just yields the raw records.
 */
async function readMemorySidecars(brainDir, { onNode, onEdge }) {
  const manifest = await readManifest(brainDir).catch(() => null);
  if (manifest) {
    const source = await openMemorySource(brainDir);
    let nodeCount = 0;
    let edgeCount = 0;
    try {
      for await (const node of source.iterateNodes()) {
        onNode(node, nodeCount);
        nodeCount++;
      }
      for await (const edge of source.iterateEdges()) {
        onEdge(edge, edgeCount);
        edgeCount++;
      }
      return {
        nodes: { count: nodeCount, parseErrors: 0 },
        edges: { count: edgeCount, parseErrors: 0 },
        manifest,
      };
    } finally {
      await source.close();
    }
  }
  const nodes = await readJsonlGz(nodesPath(brainDir), (rec, i) => onNode(rec, i));
  const edges = await readJsonlGz(edgesPath(brainDir), (rec, i) => onEdge(rec, i));
  return { nodes, edges };
}

/**
 * Memory (from the engine's NetworkMemory) uses Map for nodes, Map for
 * edges. These helpers yield serializable records from those Maps. The
 * legacy export() returns arrays already; these handle both shapes.
 */
function* iterateNodes(memory) {
  // memory.nodes is a Map<id, nodeData>
  if (memory?.nodes && typeof memory.nodes.values === 'function') {
    for (const n of memory.nodes.values()) yield serializeNodeRecord(n);
    return;
  }
  if (Array.isArray(memory?.nodes)) {
    for (const n of memory.nodes) yield serializeNodeRecord(n);
    return;
  }
}

function* iterateEdges(memory) {
  // memory.edges is a Map<"sourceId->targetId", edgeData>
  if (memory?.edges && typeof memory.edges.values === 'function') {
    for (const e of memory.edges.values()) yield e;
    return;
  }
  if (Array.isArray(memory?.edges)) {
    for (const e of memory.edges) yield e;
    return;
  }
}

function sidecarsExist(brainDir) {
  return fs.existsSync(path.join(brainDir, 'memory-manifest.json'))
    || (fs.existsSync(nodesPath(brainDir)) && fs.existsSync(edgesPath(brainDir)));
}

function summarizeCompatibilityView(nodes, edges) {
  const clusters = new Set(nodes
    .map((node) => node?.cluster)
    .filter((cluster) => cluster !== null && cluster !== undefined));
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    clusterCount: clusters.size,
  };
}

function captureCompatibilityView(memory) {
  const nodes = Array.from(iterateNodes(memory), (node) =>
    JSON.parse(JSON.stringify(serializeNodeRecord(node))));
  const edges = Array.from(iterateEdges(memory), (edge) =>
    JSON.parse(JSON.stringify(edge)));
  return {
    nodes,
    edges,
    summary: summarizeCompatibilityView(nodes, edges),
  };
}

function normalizeCompatibilityChanges(changes = {}) {
  return {
    nodes: (changes.nodes || []).map(serializeNodeRecord),
    edges: changes.edges || [],
    removedNodeIds: changes.removedNodeIds || [],
    removedEdgeKeys: changes.removedEdgeKeys || [],
  };
}

function defaultSidecarLockRoot(brainDir) {
  return path.join(path.dirname(path.resolve(brainDir)), '.home23-memory-source-locks');
}

module.exports = {
  writeMemorySidecars,
  readMemorySidecars,
  sidecarsExist,
  // Exported for tests:
  writeJsonlGz,
  readJsonlGz,
  iterateNodes,
  iterateEdges,
  NODES_FILE,
  EDGES_FILE,
  MEMORY_DELTA_FILE,
  DEFAULT_GZIP_LEVEL,
  nodesPath,
  edgesPath,
  memoryDeltaPath,
  uniqueTmpPath,
  appendMemoryDelta,
  readMemoryDeltas,
  serializeNodeRecord,
  captureCompatibilityView,
  defaultSidecarLockRoot,
};
