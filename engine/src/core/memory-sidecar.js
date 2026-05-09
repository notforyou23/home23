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

const NODES_FILE = 'memory-nodes.jsonl.gz';
const EDGES_FILE = 'memory-edges.jsonl.gz';
const DEFAULT_GZIP_LEVEL = zlib.constants.Z_BEST_SPEED;

function nodesPath(brainDir) { return path.join(brainDir, NODES_FILE); }
function edgesPath(brainDir) { return path.join(brainDir, EDGES_FILE); }

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
  const nodesResult = await writeJsonlGz(nodesPath(brainDir), iterateNodes(memory), options);
  const edgesResult = await writeJsonlGz(edgesPath(brainDir), iterateEdges(memory), options);
  return {
    nodes: { file: NODES_FILE, count: nodesResult.count, bytes: nodesResult.bytes },
    edges: { file: EDGES_FILE, count: edgesResult.count, bytes: edgesResult.bytes },
  };
}

/**
 * Read both sidecars and pump each record into the provided memory via
 * addNode / addEdge callbacks. The loader owns construction of the Map
 * structures; this module just yields the raw records.
 */
async function readMemorySidecars(brainDir, { onNode, onEdge }) {
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
    for (const n of memory.nodes.values()) yield n;
    return;
  }
  if (Array.isArray(memory?.nodes)) {
    for (const n of memory.nodes) yield n;
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
  return fs.existsSync(nodesPath(brainDir)) && fs.existsSync(edgesPath(brainDir));
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
  DEFAULT_GZIP_LEVEL,
  nodesPath,
  edgesPath,
  uniqueTmpPath,
};
