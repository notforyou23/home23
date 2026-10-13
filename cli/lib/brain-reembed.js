/** Offline memory-graph migration. Seed encoders and source brains are never rewritten by a run. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { gzip, gunzip } from 'node:zlib';

const require = createRequire(import.meta.url);
const { OWNED_EMBEDDING_PROFILE, OWNED_EMBEDDING_RECIPE_ID, LEGACY_EMBEDDING_PROFILE, canonicalizeRecipeId } = require('../../shared/semantic-encoder-contract.cjs');
const gzipAsync = promisify(gzip), gunzipAsync = promisify(gunzip), execFileAsync = promisify(execFile);
const LEGACY_ID = 'ollama:nomic-embed-text:768';
const OWNED_ID = `owned-onnx:${OWNED_EMBEDDING_PROFILE}:768`;
const RECEIPT = 'reembed-receipt.json';
const embeddingFields = ['embedding', 'embedding_status', 'embedding_recipe_id', 'embeddingRecipeId', 'embedding_encoder', 'embedder_id'];
const graphFile = name => /^(?:state\.json(?:\.gz)?|memory-(?:nodes|edges|delta|manifest|ann)[.\-]|brain-snapshot\.json)/.test(name);

function fail(message, code = 'reembed_refused') {
  throw Object.assign(new Error(message), { code });
}
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function atomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
}
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, value) { await atomic(file, JSON.stringify(value, null, 2) + '\n'); }
async function createJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function canonicalNew(file) {
  return path.join(await fs.realpath(path.dirname(path.resolve(file))), path.basename(file));
}
function contains(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }

/** Every artifact must be independent of the source, including receipts and resumed work. */
async function assertIndependentArtifacts(source, artifacts) {
  const sourceInodes = new Set();
  async function collect(file) {
    const stat = await fs.lstat(file, { bigint: true });
    sourceInodes.add(`${stat.dev}:${stat.ino}`);
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await collect(path.join(file, name));
  }
  await collect(source);
  async function inspect(file) {
    let stat;
    try { stat = await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
    if (stat.isSymbolicLink()) fail('Migration artifact is a symbolic link; source aliases are forbidden.');
    if (sourceInodes.has(`${stat.dev}:${stat.ino}`)) fail('Migration artifact is a hard link to the source.');
    const canonical = await fs.realpath(file);
    if (contains(source, canonical) || contains(canonical, source)) fail('Migration artifacts must be separate paths outside the source.');
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await inspect(path.join(file, name));
  }
  for (const artifact of artifacts) {
    if (contains(source, artifact) || contains(artifact, source)) fail('Migration artifacts must be separate paths outside the source.');
    await inspect(artifact);
  }
}

/** Hash authoritative graph bytes and the ancillary inventory. Reject aliases and unstable snapshots. */
async function fingerprint(source) {
  const hash = createHash('sha256');
  async function walk(file, relative) {
    const before = await fs.lstat(file, { bigint: true });
    if (before.isSymbolicLink()) fail('Source contains a symbolic link; use a regular, independent brain snapshot.');
    if (before.isDirectory()) {
      const names = (await fs.readdir(file)).sort();
      hash.update(`directory:${relative}:${names.join('\0')}\n`);
      for (const name of names) await walk(path.join(file, name), path.join(relative, name));
    } else if (before.isFile()) {
      hash.update(`file:${relative}:${before.size}:${before.mtimeNs}:${before.ctimeNs}\n`);
      if (!relative || graphFile(path.basename(relative))) {
        for await (const chunk of createReadStream(file)) hash.update(chunk);
      }
    } else fail('Source contains a non-regular file.');
    const after = await fs.lstat(file, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('Source changed while it was read.', 'source_changed');
  }
  await walk(source, '');
  return hash.digest('hex');
}

async function loadBrain(source) {
  const directory = (await fs.stat(source)).isDirectory();
  let stateFile = source;
  if (directory) {
    stateFile = await exists(path.join(source, 'state.json.gz')) ? path.join(source, 'state.json.gz') : path.join(source, 'state.json');
    if (!await exists(stateFile)) fail('A brain directory must contain state.json.gz or state.json.');
  }
  const bytes = await fs.readFile(stateFile);
  const document = JSON.parse((stateFile.endsWith('.gz') ? await gunzipAsync(bytes) : bytes).toString('utf8'));
  const memory = document.memory ?? document;
  if (!memory || !Array.isArray(memory.nodes) || !Array.isArray(memory.edges)) fail('Unsupported brain: expected memory.nodes and memory.edges arrays.');
  let sidecars = false;
  const brainDir = path.dirname(stateFile);
  const hasManifest = await exists(path.join(brainDir, 'memory-manifest.json'));
  const hasNodes = await exists(path.join(brainDir, 'memory-nodes.jsonl.gz'));
  const hasEdges = await exists(path.join(brainDir, 'memory-edges.jsonl.gz'));
  if (!directory && document.memory && (hasManifest || hasNodes || hasEdges)) fail('This engine brain has sidecars. Pass its directory, not only state.json.gz.');
  if (directory && (hasManifest || hasNodes || hasEdges)) {
    if (!hasManifest && hasNodes !== hasEdges) fail('Incomplete brain sidecars.');
    sidecars = true;
    if (hasManifest) {
      const { openMemorySource, readManifest, readJsonl, edgeKeyFor } = require('../../shared/memory-source');
      const scratch = await fs.mkdtemp(path.join(tmpdir(), 'home23-reembed-read-'));
      const reader = await openMemorySource(source, { operationRoot: scratch });
      try {
        // The source reader canonicalizes ids for lookup. Preserve their stored JSON types in the copy.
        const manifest = await readManifest(source), nodeIds = new Map(), edgeIdentities = new Map();
        const rememberEdge = record => edgeIdentities.set(edgeKeyFor(record), Object.fromEntries(['source', 'target'].filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])));
        for await (const record of readJsonl(path.join(source, manifest.activeBase.nodes.file), { gzip: true, confinedRoot: source, expectedInputBytes: manifest.activeBase.nodes.bytes, expectedRecordCount: manifest.activeBase.nodes.count })) nodeIds.set(String(record.id), record.id);
        for await (const record of readJsonl(path.join(source, manifest.activeBase.edges.file), { gzip: true, confinedRoot: source, expectedInputBytes: manifest.activeBase.edges.bytes, expectedRecordCount: manifest.activeBase.edges.count })) rememberEdge(record);
        for await (const entry of readJsonl(path.join(source, manifest.activeDelta.file), { confinedRoot: source, byteLimit: manifest.activeDelta.committedBytes, requireCompletePrefix: true, allowTrailingBytes: true })) {
          if (entry.op === 'upsert_node') nodeIds.set(String(entry.record.id), entry.record.id);
          if (entry.op === 'upsert_edge') rememberEdge(entry.record);
        }
        memory.nodes = [];
        memory.edges = [];
        for await (const node of reader.iterateNodes()) memory.nodes.push({ ...structuredClone(node), id: nodeIds.get(String(node.id)) });
        for await (const edge of reader.iterateEdges()) {
          const record = structuredClone(edge), identity = edgeIdentities.get(edgeKeyFor(edge));
          if (!identity) fail('Memory source edge identity is missing.');
          delete record.source; delete record.target;
          memory.edges.push({ ...record, ...identity });
        }
        const summary = await reader.summarize();
        if (summary.nodes !== memory.nodes.length || summary.edges !== memory.edges.length) fail('Memory manifest totals do not match its graph.');
      } finally { await reader.close(); await fs.rm(scratch, { recursive: true, force: true }); }
    } else {
      const { readMemorySidecars, readMemoryDeltas } = require('../../engine/src/core/memory-sidecar.js');
      const nodes = new Map(), edges = new Map();
      const edgeKey = edge => edge.key ?? [edge.source ?? edge.from, edge.target ?? edge.to].map(String).sort().join('->');
      const handlers = {
        onNode(node) { nodes.set(String(node.id), node); },
        onEdge(edge) { edges.set(edgeKey(edge), edge); },
        onRemoveNode(id) {
          nodes.delete(String(id));
          for (const [key, edge] of edges) if ([edge.source ?? edge.from, edge.target ?? edge.to].some(value => String(value) === String(id))) edges.delete(key);
        },
        onRemoveEdge(key) { edges.delete(String(key)); },
      };
      const base = await readMemorySidecars(source, handlers);
      const delta = await readMemoryDeltas(source, handlers);
      if (base.nodes.parseErrors || base.edges.parseErrors || delta.parseErrors) fail('Brain sidecar or delta contains invalid records.');
      memory.nodes = [...nodes.values()]; memory.edges = [...edges.values()];
    }
  }
  const tuples = memory.nodes.length > 0 && Array.isArray(memory.nodes[0]);
  const nodes = memory.nodes.map((entry, index) => {
    const node = tuples ? entry?.[1] : entry;
    if (!node || typeof node !== 'object' || Array.isArray(node) || (tuples && (entry.length !== 2 || (node.id !== undefined && node.id !== entry[0])))) fail(`Invalid node at position ${index}.`);
    return node;
  });
  const recordedId = memory.metadata?.embedderId ?? LEGACY_ID;
  if (typeof recordedId !== 'string' || !recordedId) fail('Brain embedder id is invalid.');
  for (const node of nodes) {
    if (!node.embedding) continue;
    if ((node.embedder_id || LEGACY_ID) !== recordedId) fail('Source contains mixed embedder ids; unstamped vectors belong to the legacy provider.');
    for (const field of ['embedding_recipe_id', 'embeddingRecipeId', 'embedding_encoder']) {
      const recipe = canonicalizeRecipeId(node[field]);
      if (recipe === OWNED_EMBEDDING_PROFILE && recordedId !== OWNED_ID
          || recipe === LEGACY_EMBEDDING_PROFILE && recordedId === OWNED_ID) fail('Source contains mixed embedding recipes.');
    }
  }
  return { directory, document, memory, nodes, tuples, sidecars, stateName: path.basename(stateFile), recordedId };
}
const nodeText = node => typeof node.concept === 'string' ? node.concept : typeof node.text === 'string' ? node.text : typeof node.content === 'string' ? node.content : '';
function normalize(vector, dimensions) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) fail('Provider returned an invalid vector.');
  const values = Array.from(vector);
  if (values.length !== dimensions || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('Provider returned wrong dimensions or nonfinite values.');
  const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (!scale) fail('Provider returned a zero or invalid vector.');
  const norm = Math.sqrt(values.reduce((sum, value) => sum + (value / scale) ** 2, 0));
  return values.map(value => (value / scale) / norm);
}
function prepare(brain, targetId) {
  for (const node of brain.nodes) for (const field of embeddingFields) delete node[field];
  brain.memory.metadata = { ...brain.memory.metadata, embedderId: targetId };
}
function stampVector(node, vector, targetId) {
  node.embedding = vector;
  node.embedding_status = 'embedded';
  node.embedder_id = targetId;
  if (targetId === OWNED_ID) {
    node.embedding_recipe_id = OWNED_EMBEDDING_RECIPE_ID;
    node.embedding_encoder = OWNED_EMBEDDING_PROFILE;
  }
}
async function saveBrain(brain, destination) {
  if (brain.directory) {
    const stateFile = path.join(destination, brain.stateName);
    if (brain.sidecars) {
      const { writeJsonlGz } = require('../../engine/src/core/memory-sidecar.js');
      await writeJsonlGz(path.join(destination, 'memory-nodes.jsonl.gz'), brain.nodes);
      await writeJsonlGz(path.join(destination, 'memory-edges.jsonl.gz'), brain.memory.edges);
      const savedNodes = brain.memory.nodes, savedEdges = brain.memory.edges;
      brain.memory.nodes = []; brain.memory.edges = [];
      try { await atomic(stateFile, brain.stateName.endsWith('.gz') ? await gzipAsync(JSON.stringify(brain.document)) : JSON.stringify(brain.document)); }
      finally { brain.memory.nodes = savedNodes; brain.memory.edges = savedEdges; }
    } else await atomic(stateFile, brain.stateName.endsWith('.gz') ? await gzipAsync(JSON.stringify(brain.document)) : JSON.stringify(brain.document));
    const snapshotFile = path.join(destination, 'brain-snapshot.json');
    if (await exists(snapshotFile)) {
      const snapshot = await json(snapshotFile);
      const { size } = await fs.stat(stateFile);
      await writeJson(snapshotFile, { ...snapshot, nodeCount: brain.nodes.length, edgeCount: brain.memory.edges.length, nodesWithEmbeddings: brain.nodes.filter(node => node.embedding).length, fileSize: size, embedderId: brain.memory.metadata.embedderId });
    }
  } else await atomic(destination, destination.endsWith('.gz') ? await gzipAsync(JSON.stringify(brain.document)) : JSON.stringify(brain.document));
}

async function settings(homeRoot, options, deps) {
  let raw = {};
  let ownedEnvironment = {};
  // Product commands receive the Host root; source/operator commands receive its app root.
  const appRoot = await exists(path.join(homeRoot, 'app/config/home.yaml')) ? path.join(homeRoot, 'app') : homeRoot;
  const embeddingBlock = value => value.architecture?.memory?.embedding ?? value.memory?.embedding ?? value.embedding ?? {};
  if (!options.config) {
    const baseFile = path.join(appRoot, 'configs/base-engine.yaml');
    if (await exists(baseFile)) raw = embeddingBlock(require('js-yaml').load(await fs.readFile(baseFile, 'utf8')) || {});
  }
  const configFile = options.config ? path.resolve(options.config) : path.join(appRoot, 'config/home.yaml');
  if (options.config || await exists(configFile)) {
    const yaml = require('js-yaml');
    const document = yaml.load(await fs.readFile(configFile, 'utf8')) || {};
    raw = { ...raw, ...(options.config && document.provider ? document : embeddingBlock(document)) };
    if (!options.config) {
      const selected = document.embeddings?.providers?.find(item => item?.provider && item?.model);
      if (['home23-owned', 'owned-onnx'].includes(selected?.provider)) {
        // Match the Host-generated encoder environment without reading credentials.
        // Explicit memory providers still win through resolveEmbeddingConfig.
        ownedEnvironment = {
          EMBEDDING_PROVIDER: 'home23-owned', EMBEDDING_MODEL: selected.model,
          EMBEDDING_DIMENSIONS: String(selected.dimensions ?? 768),
          EMBEDDING_BASE_URL: selected.endpoint || selected.baseUrl || '',
        };
      }
    }
  }
  const overrides = Object.fromEntries(['provider', 'model', 'dimensions', 'batchSize', 'baseUrl'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  const { resolveEmbeddingConfig, embeddingId } = require('../../engine/src/memory/embedding-provider.js');
  const config = resolveEmbeddingConfig({ ...raw, ...overrides }, { ...ownedEnvironment, ...(deps.env ?? process.env) });
  const pricePerMillion = Number(options.pricePerMillion ?? raw.pricePerMillion ?? config.pricePerMillionTokens ?? 0.20);
  const requestsPerMinute = Number(options.requestsPerMinute ?? config.requestsPerMinute ?? 60);
  if (!Number.isFinite(pricePerMillion) || pricePerMillion < 0) fail('Price per million tokens must be a nonnegative number.');
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) fail('Requests per minute must be a positive number.');
  return { config, targetId: embeddingId(config), pricePerMillion, requestsPerMinute };
}

async function listProcessesDefault() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) fail('Process inventory is unreadable.');
    return { pid: Number(match[1]), command: match[2] };
  });
}
function pidRunningDefault(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
/** Failure to inspect is not evidence that an engine stopped. */
export async function assertEngineStopped(source, options = {}, deps = {}) {
  let rows;
  try { rows = await (deps.listProcesses ?? listProcessesDefault)(); } catch { fail('Cannot verify engine processes. Stop the engine and retry with --engine-pid-file.'); }
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.pid) || typeof row.command !== 'string')) fail('Invalid engine process inventory.');
  const sourceDir = (await fs.stat(source)).isDirectory() ? source : path.dirname(source);
  const scope = [source, sourceDir];
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    const matches = scope.some(value => row.command.includes(value) || row.sourcePath === value || (row.cwd && contains(value, row.cwd)));
    const engine = /(?:engine[/\\](?:src[/\\])?(?:index|main)|orchestrator|cosmo-engine|(?:^|\s)src[/\\]index\.js)/i.test(row.command);
    if (matches || engine && !row.sourcePath) fail('Engine appears running or cannot be scoped safely. Stop it before --swap.');
  }
  const pidFile = options.enginePidFile ? path.resolve(options.enginePidFile) : path.join(sourceDir, 'engine.pid');
  if (!await exists(pidFile)) fail('Stopped-engine PID evidence is required. Supply --engine-pid-file from the stopped engine.');
  const raw = (await fs.readFile(pidFile, 'utf8')).trim();
  let pid;
  try { pid = /^\d+$/.test(raw) ? Number(raw) : Number(JSON.parse(raw).pid); } catch { fail('Engine PID file is invalid.'); }
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('Engine PID file is invalid.');
  let running;
  try { running = await (deps.isPidRunning ?? pidRunningDefault)(pid); } catch { fail('Cannot verify the recorded engine PID.'); }
  if (running !== false || rows.some(row => row.pid === pid)) fail('The recorded engine PID is still running.');
  return { pid, pidFile, inspected: true };
}

function receiptPath(output, directory) { return directory ? path.join(output, RECEIPT) : `${output}.${RECEIPT}`; }
async function outputFingerprint(output, directory) {
  const hash = createHash('sha256');
  async function walk(file, relative) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) fail('Output contains a symbolic link.');
    if (stat.isDirectory()) {
      const names = (await fs.readdir(file)).filter(name => relative || name !== RECEIPT).sort();
      hash.update(`directory:${relative}:${names.join('\0')}\n`);
      for (const name of names) await walk(path.join(file, name), path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(`file:${relative}:${stat.size}\n`);
      for await (const chunk of createReadStream(file)) hash.update(chunk);
    } else fail('Output contains a non-regular file.');
  }
  await walk(output, '');
  return hash.digest('hex');
}

async function swapBrain(source, output, brain, selected, options, deps) {
  if (!await exists(output)) fail('Completed output is required before --swap.');
  const receiptFile = receiptPath(output, brain.directory), receiptBytes = await fs.readFile(receiptFile);
  const receipt = JSON.parse(receiptBytes);
  if (receipt.status !== 'completed' || receipt.source !== source || receipt.sourceId !== brain.recordedId || receipt.targetId !== selected.targetId) fail('Output, source, and configured embedder ids do not match.');
  if (receipt.sourceHash !== await fingerprint(source)) fail('Source changed since re-embedding. Create a fresh copy.', 'source_changed');
  if (receipt.outputHash !== await outputFingerprint(output, brain.directory)) fail('Completed output changed since publication.');
  const completed = await loadBrain(output);
  if (completed.recordedId !== selected.targetId || completed.nodes.length !== brain.nodes.length) fail('Output metadata or node count does not match the migration.');
  for (const node of completed.nodes) {
    if (!nodeText(node)) continue;
    if (node.embedder_id !== selected.targetId || !node.embedding) fail('Output is incomplete or contains mixed vector spaces.');
    normalize(node.embedding, selected.config.dimensions);
  }
  const stopped = await assertEngineStopped(source, options, deps);
  await assertIndependentArtifacts(source, [output, receiptFile, `${output}.reembed-work`]);
  if (receipt.sourceHash !== await fingerprint(source)) fail('Source changed during stopped-engine verification.', 'source_changed');
  if (!receiptBytes.equals(await fs.readFile(receiptFile))) fail('Completed output receipt changed during stopped-engine verification.');
  if (receipt.outputHash !== await outputFingerprint(output, brain.directory)) fail('Completed output changed during stopped-engine verification.');
  const backup = `${source}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const priorReceipt = !brain.directory && await exists(receiptPath(source, false));
  await fs.rename(source, backup);
  try {
    if (priorReceipt) await fs.rename(receiptPath(source, false), receiptPath(backup, false));
    await fs.rename(output, source);
  } catch (error) {
    await fs.rename(backup, source);
    if (priorReceipt && await exists(receiptPath(backup, false))) await fs.rename(receiptPath(backup, false), receiptPath(source, false));
    throw error;
  }
  // Standalone receipts live beside the JSON; retain them with the activated file.
  if (!brain.directory) await fs.rename(receiptPath(output, false), receiptPath(source, false));
  return { status: 'swapped', source, backup, targetId: selected.targetId, stopped };
}

export async function reembedBrain(sourcePath, options = {}, deps = {}) {
  if (options.run && options.swap || options.dryRun && (options.run || options.swap) || options.resume && !options.run) fail('Use dry-run, run (optionally resume), or swap as separate steps.');
  const source = await fs.realpath(path.resolve(sourcePath));
  const initialSourceHash = await fingerprint(source);
  const brain = await loadBrain(source);
  if (initialSourceHash !== await fingerprint(source)) fail('Source changed while loading the brain.', 'source_changed');
  const selected = await settings(options.homeRoot ?? process.cwd(), options, deps);
  const { config, targetId, pricePerMillion, requestsPerMinute } = selected;
  const texts = brain.nodes.map(nodeText);
  const eligible = texts.map((text, index) => text ? index : -1).filter(index => index >= 0);
  const characters = texts.reduce((sum, text) => sum + text.length, 0);
  const tokens = characters / 4;
  const estimate = {
    status: 'dry-run', source, sourceId: brain.recordedId, targetId,
    nodes: brain.nodes.length, nodesToEmbed: eligible.length, characters,
    estimatedInputTokens: tokens, pricePerMillion, estimatedCost: tokens / 1_000_000 * pricePerMillion,
    batches: Math.ceil(eligible.length / config.batchSize), requestsPerMinute,
    estimatedSeconds: Math.ceil(eligible.length / config.batchSize) / requestsPerMinute * 60,
    estimateNote: 'Tokens use characters / 4. Cost and time are estimates; retries and service latency add time.',
  };
  if (!options.run && !options.swap) return estimate;
  if (!options.output) fail('Specify --output for a new copy. Source-in-place runs are forbidden.');
  const output = await canonicalNew(options.output);
  if (contains(source, output) || contains(output, source) || await exists(output) && await fs.realpath(output) === source) fail('Output must be a separate path outside the source.');
  const work = `${output}.reembed-work`, checkpointFile = path.join(work, 'checkpoint.json');
  const data = path.join(work, brain.directory ? 'data' : path.basename(output));
  const finalReceipt = receiptPath(output, brain.directory);
  if (!brain.directory) {
    const sourceReceipt = receiptPath(source, false);
    if ([output, finalReceipt, work].some(artifact => contains(sourceReceipt, artifact) || contains(artifact, sourceReceipt))) fail('Migration artifacts overlap the source receipt.');
    if (await exists(sourceReceipt)) await assertIndependentArtifacts(sourceReceipt, [output, finalReceipt, work]);
  }
  await assertIndependentArtifacts(source, [output, finalReceipt, work, checkpointFile, data, path.join(work, 'batches')]);
  if (!brain.directory && !options.swap && await exists(finalReceipt) && !(options.resume && await exists(output))) fail('Output receipt already exists; unrelated receipts are never overwritten.');
  if (options.swap) return swapBrain(source, output, brain, selected, options, deps);
  const sourceHash = initialSourceHash;
  if (await exists(output)) {
    if (!options.resume || !await exists(checkpointFile)) fail('Output already exists. Use a new output path; completed copies are never overwritten.');
    const published = await json(checkpointFile);
    if (!['publishing', 'completed'].includes(published.status) || published.source !== source || published.sourceHash !== sourceHash || published.sourceId !== brain.recordedId || published.targetId !== targetId || published.output !== output || published.batchSize !== config.batchSize || !published.receipt) fail('Existing output does not match the resumable publication.');
    if (published.receipt.outputHash !== await outputFingerprint(output, brain.directory)) fail('Published output changed; refusing to resume.');
    const receiptFile = receiptPath(output, brain.directory);
    if (await exists(receiptFile)) {
      const recorded = await json(receiptFile);
      if (recorded.sourceHash !== published.receipt.sourceHash || recorded.outputHash !== published.receipt.outputHash || recorded.targetId !== targetId || recorded.status !== 'completed') fail('Published receipt differs from the checkpoint.');
    } else await createJson(receiptFile, published.receipt);
    published.status = 'completed'; await writeJson(checkpointFile, published);
    return published.receipt;
  }
  let checkpoint;
  if (options.resume) {
    if (!await exists(checkpointFile)) fail('No checkpoint exists for this output.');
    checkpoint = await json(checkpointFile);
    if (checkpoint.source !== source || checkpoint.sourceHash !== sourceHash || checkpoint.sourceId !== brain.recordedId || checkpoint.targetId !== targetId || checkpoint.output !== output || checkpoint.batchSize !== config.batchSize) fail('Resume source, output, or target id differs from the checkpoint.', 'source_changed');
    if (!['running', 'publishing'].includes(checkpoint.status)) fail('Checkpoint is not resumable.');
    if (checkpoint.status === 'running' && checkpoint.cleanHash !== await outputFingerprint(data, brain.directory)) fail('Checkpoint snapshot changed.');
  } else {
    if (await exists(work)) fail('Migration work already exists. Use --run --resume.');
    await fs.mkdir(work, { mode: 0o700 });
    await fs.mkdir(path.join(work, 'batches'), { mode: 0o700 });
    prepare(brain, targetId);
    if (brain.directory) {
      await fs.cp(source, data, { recursive: true, errorOnExist: true, force: false });
      await fs.chmod(data, 0o700);
      await fs.rm(path.join(data, RECEIPT), { force: true });
      // Retire every old base, delta and ANN index before any target request.
      for (const name of await fs.readdir(data)) if (/^memory-(?:nodes|edges|delta|manifest|ann)[.\-]/.test(name)) await fs.rm(path.join(data, name), { force: true });
      const obsoleteState = brain.stateName.endsWith('.gz') ? 'state.json' : 'state.json.gz';
      await fs.rm(path.join(data, obsoleteState), { force: true });
    }
    await saveBrain(brain, data);
    checkpoint = { version: 1, status: 'running', source, sourceHash, sourceId: brain.recordedId, targetId, output, batchSize: config.batchSize, next: 0, batches: [], cleanHash: await outputFingerprint(data, brain.directory) };
    await writeJson(checkpointFile, checkpoint);
    if (sourceHash !== await fingerprint(source)) fail('Source changed while preparing the copy.', 'source_changed');
  }
  // A clean source-derived graph is reconstructed on every resume; old vectors never enter it.
  prepare(brain, targetId);
  let covered = 0;
  for (const batch of checkpoint.batches) {
    const bytes = await fs.readFile(path.join(work, 'batches', batch.file));
    if (createHash('sha256').update(bytes).digest('hex') !== batch.hash) fail('Checkpoint vector batch changed.');
    const records = JSON.parse(bytes);
    if (!Array.isArray(records) || !records.length || records.length > config.batchSize || batch.file !== `${covered}.json`) fail('Checkpoint batch sequence is invalid.');
    for (const { index, vector, id } of records) {
      if (id !== targetId || eligible[covered++] !== index) fail('Checkpoint contains invalid or mixed vector spaces.');
      stampVector(brain.nodes[index], normalize(vector, config.dimensions), targetId);
    }
  }
  if (covered !== checkpoint.next || covered > eligible.length) fail('Checkpoint progress is invalid.');
  let provider;
  if (checkpoint.next < eligible.length) {
    const { createEmbeddingProvider } = require('../../engine/src/memory/embedding-provider.js');
    const providerDeps = { ...deps.providerDeps, env: deps.env ?? deps.providerDeps?.env ?? process.env };
    provider = await (deps.createProvider ?? createEmbeddingProvider)(config, providerDeps);
    if (provider.id !== targetId) fail('Provider id differs from the migration target.');
  }
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let firstBatch = true;
  for (let start = checkpoint.next; start < eligible.length; start += config.batchSize) {
    if (!firstBatch) await sleep(60_000 / requestsPerMinute);
    firstBatch = false;
    const indices = eligible.slice(start, start + config.batchSize);
    const vectors = await provider.embedBatch(indices.map(index => texts[index]), { recordedId: targetId });
    if (!Array.isArray(vectors) || vectors.length !== indices.length) fail('Provider batch is incomplete.');
    const records = indices.map((index, position) => ({ index, id: targetId, vector: normalize(vectors[position], config.dimensions) }));
    const file = `${start}.json`, bytes = Buffer.from(JSON.stringify(records));
    await atomic(path.join(work, 'batches', file), bytes);
    for (const { index, vector } of records) stampVector(brain.nodes[index], vector, targetId);
    checkpoint.batches.push({ file, hash: createHash('sha256').update(bytes).digest('hex') });
    checkpoint.next = start + indices.length;
    await writeJson(checkpointFile, checkpoint);
  }
  if (eligible.some(index => !brain.nodes[index].embedding)) fail('Checkpoint did not cover every eligible node.');
  await assertIndependentArtifacts(source, [output, finalReceipt, work]);
  if (sourceHash !== await fingerprint(source)) fail('Source changed before publishing. Create a fresh copy.', 'source_changed');
  checkpoint.status = 'publishing'; await writeJson(checkpointFile, checkpoint);
  await saveBrain(brain, data);
  const receipt = { ...estimate, status: 'completed', output, sourceHash, outputHash: await outputFingerprint(data, brain.directory), completedAt: new Date().toISOString() };
  checkpoint.receipt = receipt; await writeJson(checkpointFile, checkpoint);
  await assertIndependentArtifacts(source, [output, finalReceipt, work]);
  if (await exists(output)) fail('Output appeared during migration; refusing to replace it.');
  if (await exists(finalReceipt)) fail('Output receipt appeared during migration; refusing to replace it.');
  if (brain.directory) await fs.rename(data, output);
  else { await fs.link(data, output); await fs.rm(data); }
  await createJson(finalReceipt, receipt);
  checkpoint.status = 'completed'; await writeJson(checkpointFile, checkpoint);
  return receipt;
}

export async function runBrainReembedCommand(homeRoot, args, deps = {}) {
  const options = { homeRoot };
  let source;
  const values = { '--output': 'output', '--config': 'config', '--price-per-million': 'pricePerMillion', '--requests-per-minute': 'requestsPerMinute', '--engine-pid-file': 'enginePidFile', '--provider': 'provider', '--model': 'model', '--dimensions': 'dimensions', '--batch-size': 'batchSize', '--base-url': 'baseUrl' };
  const flags = { '--dry-run': 'dryRun', '--run': 'run', '--resume': 'resume', '--swap': 'swap' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags[arg]) options[flags[arg]] = true;
    else if (values[arg]) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`Missing value for ${arg}.`);
      const key = values[arg], value = args[++index];
      options[key] = ['dimensions', 'batchSize', 'pricePerMillion', 'requestsPerMinute'].includes(key) ? Number(value) : value;
    } else if (!arg.startsWith('-') && source === undefined) source = arg;
    else fail(`Unknown re-embed argument: ${arg}`);
  }
  if (!source) fail('Usage: home23 brain re-embed <source> [--output <path>] [--dry-run | --run [--resume] | --swap]');
  const receipt = await reembedBrain(source, options, deps);
  (deps.stdout ?? process.stdout).write(JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
