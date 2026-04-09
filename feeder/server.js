'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');

const yaml = require('js-yaml');
const chokidar = require('chokidar');

const BASE_DIR = __dirname;
const CONFIG_PATH = process.env.FEEDER_CONFIG
  ? path.resolve(BASE_DIR, process.env.FEEDER_CONFIG)
  : path.join(BASE_DIR, 'feeder.yaml');
const config = loadConfig();
const memberName = config.member || 'default';
const MANIFEST_PATH = path.join(BASE_DIR, `manifest-${memberName}.json`);
const PENDING_PATH = path.join(BASE_DIR, `pending-${memberName}.json`);
const stateFile = resolvePath(config.state_file || '../runs/default/state.json.gz');
const flushIntervalMs = (config.flush_interval_seconds || 300) * 1000;
const flushBatchSize = config.flush_batch_size || 20;

ensureJsonFile(MANIFEST_PATH, {});
ensureJsonFile(PENDING_PATH, []);

let manifest = loadJson(MANIFEST_PATH, {});
let pendingQueue = normalizePending(loadJson(PENDING_PATH, []));
let flushInProgress = false;
let queueLock = Promise.resolve();

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const loaded = yaml.load(raw) || {};
    loaded.watch = Array.isArray(loaded.watch) ? loaded.watch : [];
    return loaded;
  } catch (err) {
    console.error(`Failed to load feeder config: ${err.message}`);
    process.exit(1);
  }
}

function resolvePath(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(BASE_DIR, value);
}

function ensureJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
  }
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizePending(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean);
}

function saveManifest() {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

let pendingSaveTimer = null;
function savePending() {
  // Debounce: batch multiple save calls into a single disk write
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = setTimeout(() => {
    fs.writeFileSync(PENDING_PATH, JSON.stringify(pendingQueue, null, 2));
    pendingSaveTimer = null;
  }, 100);  // batch writes within 100ms window
}

function hashContent(content) {
  const fullHash = crypto.createHash('sha256').update(content).digest('hex');
  return { fullHash, shortHash: fullHash.slice(0, 16) };
}

function expandBraces(pattern) {
  const m = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!m) return [pattern];
  return m[2].split(',').map(ext => `${m[1]}${ext.trim()}${m[3]}`);
}

function matchesGlob(filePath, globPattern) {
  if (!globPattern) return true;
  const filename = path.basename(filePath);
  if (globPattern === '*') return true;

  // Expand brace patterns: *.{md,txt} → ['*.md', '*.txt']
  const patterns = expandBraces(globPattern);
  if (patterns.length > 1) return patterns.some(p => matchesGlob(filePath, p));

  if (!globPattern.includes('*')) return filename === globPattern;

  const parts = globPattern.split('*').filter(Boolean);
  if (!parts.length) return true;

  let index = 0;
  for (const part of parts) {
    const found = filename.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }

  if (!globPattern.startsWith('*') && !filename.startsWith(parts[0])) return false;
  if (!globPattern.endsWith('*') && !filename.endsWith(parts[parts.length - 1])) return false;
  return true;
}

function runWithQueueLock(task) {
  queueLock = queueLock.then(task, task);
  return queueLock;
}

function buildNode(item, nodeId) {
  return {
    id: nodeId,
    concept: item.concept,
    content: item.content,
    tag: item.tag,
    embedding: item.embedding,
    connections: [],
    strength: 0.5,
    lastAccessed: Date.now(),
    accessCount: 0,
    metadata: {
      source: 'home23-feeder',
      sourcePath: item.filePath || item.sourcePath,
      chunkKey: item.sourcePath,
      chunkIndex: item.chunkIndex ?? 0,
      totalChunks: item.totalChunks ?? 1,
      label: item.label,
      ingestedAt: item.ingestedAt,
      contentHash: item.contentHash,
    },
  };
}

async function loadState() {
  if (!fs.existsSync(stateFile)) {
    console.error(`State file not found: ${stateFile}`);
    return null;
  }
  try {
    const compressed = fs.readFileSync(stateFile);
    const raw = await new Promise((resolve, reject) => {
      zlib.gunzip(compressed, (err, result) => err ? reject(err) : resolve(result.toString('utf8')));
    });
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read state: ${err.message}`);
    return null;
  }
}

async function saveState(state) {
  try {
    const raw = JSON.stringify(state);
    const compressed = await new Promise((resolve, reject) => {
      zlib.gzip(Buffer.from(raw, 'utf8'), (err, result) => err ? reject(err) : resolve(result));
    });
    fs.writeFileSync(stateFile, compressed);
    return true;
  } catch (err) {
    console.error(`Failed to save state: ${err.message}`);
    return false;
  }
}

function getEmbeddingRequest(text) {
  const endpoint = config.ollama?.endpoint || 'http://127.0.0.1:11434';
  const model = config.ollama?.model || 'nomic-embed-text';
  const base = new URL(endpoint);
  const trimmedPath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
  const openAiMode = trimmedPath.includes('/v1');
  const pathSuffix = openAiMode ? '/embeddings' : '/api/embeddings';
  const finalPath = `${trimmedPath}${pathSuffix}` || pathSuffix;
  const body = openAiMode
    ? { model, input: text }
    : { model, prompt: text };
  return {
    url: {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: finalPath,
    },
    body,
    openAiMode,
  };
}

function parseEmbedding(openAiMode, payload) {
  if (!payload) return null;
  if (openAiMode) return payload?.data?.[0]?.embedding || null;
  return payload?.embedding || payload?.data?.[0]?.embedding || null;
}

function postJson(url, body) {
  const payload = JSON.stringify(body);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve(null);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

async function embedText(text) {
  // Try progressively smaller slices
  const LIMITS = [7000, 3500, 2000];
  const MIN_LIMIT = Math.min(...LIMITS);
  for (const limit of LIMITS) {
    const safeText = text.length > limit ? text.slice(0, limit) : text;
    const request = getEmbeddingRequest(safeText);
    const payload = await postJson(request.url, request.body);
    const embedding = parseEmbedding(request.openAiMode, payload);
    if (embedding) {
      if (config.ollama?.dims && embedding.length !== config.ollama.dims) {
        console.warn(`Embedding dims ${embedding.length} != ${config.ollama.dims}`);
      }
      return embedding;
    }
    // Only bail if the text is already at or below the minimum slice — retrying smaller won't help
    if (text.length <= MIN_LIMIT) return null;
  }
  return null;
}

const CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 300;

function chunkContent(content) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + CHUNK_SIZE, content.length);
    chunks.push(content.slice(start, end));
    if (end === content.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

function upsertPending(queue, items) {
  // items is an array of chunks for a single file — remove all old chunks for that file first
  const filePath = items[0].filePath;
  const next = queue.filter(entry => entry.filePath !== filePath);
  return [...next, ...items];
}

async function enqueueFile(filePath, watchEntry) {
  if (!matchesGlob(filePath, watchEntry.glob)) return;
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!stats.isFile()) return;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`Failed to read ${filePath}: ${err.message}`);
    return;
  }

  if (!content || !content.trim()) return;

  const { fullHash, shortHash } = hashContent(content);
  if (manifest[filePath]?.hash === fullHash) return;

  const label = watchEntry.label || 'feeder';
  const chunks = chunkContent(content);
  const ingestedAt = new Date().toISOString();

  const items = chunks.map((chunk, i) => ({
    filePath,                              // canonical file key
    sourcePath: `${filePath}#chunk-${i}`, // unique per chunk
    chunkIndex: i,
    totalChunks: chunks.length,
    label,
    tag: label,
    content: chunk,
    concept: i === 0 ? content.slice(0, 200) : chunk.slice(0, 200),
    embedding: null,
    contentHash: shortHash,
    hash: fullHash,
    ingestedAt,
  }));

  await runWithQueueLock(() => {
    pendingQueue = upsertPending(pendingQueue, items);
    savePending();
  });

  if (pendingQueue.length >= flushBatchSize) {
    triggerFlush('batch');
  }
}

async function flushPending(reason) {
  if (flushInProgress) return;
  if (!pendingQueue.length) return;

  flushInProgress = true;
  // Only process up to flushBatchSize items per flush — prevents OOM on large queues
  const snapshot = pendingQueue.slice(0, flushBatchSize);
  const overflow = pendingQueue.slice(flushBatchSize);
  const remaining = [];
  const readyItems = [];

  for (const item of snapshot) {
    if (!item.embedding) {
      const embedding = await embedText(item.content);
      if (!embedding) {
        remaining.push(item);
        continue;
      }
      item.embedding = embedding;
    }
    readyItems.push(item);
  }

  if (!readyItems.length) {
    pendingQueue = [...remaining, ...overflow];
    savePending();
    flushInProgress = false;
    return;
  }

  const state = await loadState();
  if (!state) {
    pendingQueue = [...snapshot, ...overflow];
    savePending();
    flushInProgress = false;
    return;
  }

  if (!state.memory) state.memory = {};
  if (!Array.isArray(state.memory.nodes)) state.memory.nodes = [];
  if (!Array.isArray(state.memory.edges)) state.memory.edges = [];

  // Remove stale chunk nodes for files that are being re-ingested
  const reingesting = new Set(readyItems.map(i => i.filePath || i.sourcePath));
  for (const fileKey of reingesting) {
    const oldEntry = manifest[fileKey];
    // Support both old format (nodeId singular) and new format (nodeIds array)
    const staleIdList = oldEntry?.nodeIds || (oldEntry?.nodeId ? [oldEntry.nodeId] : []);
    if (staleIdList.length) {
      const staleIds = new Set(staleIdList);
      state.memory.nodes = state.memory.nodes.filter(n => !staleIds.has(n.id));
      state.memory.edges = state.memory.edges.filter(e => !staleIds.has(e.from) && !staleIds.has(e.to));
    }
  }

  const nodes = state.memory.nodes;
  const maxExistingId = nodes.reduce((maxId, node) => {
    const value = Number(node.id) || 0;
    return value > maxId ? value : maxId;
  }, 0);

  let nextId = maxExistingId;
  const updatedManifest = { ...manifest };

  for (const item of readyItems) {
    nextId += 1;
    // Use prefixed IDs so feeder nodes don't collide with engine's numeric IDs
    const node = buildNode(item, `feeder_${nextId}`);
    nodes.push(node);
    // Manifest keyed by canonical filePath — accumulate nodeIds for all chunks
    const fileKey = item.filePath || item.sourcePath;
    const existing = updatedManifest[fileKey];
    updatedManifest[fileKey] = {
      hash: item.hash,
      label: item.label || null,
      ingestedAt: item.ingestedAt,
      nodeIds: [...(existing?.nodeIds || []), `feeder_${nextId}`],
    };
  }

  state.memory.nextNodeId = Math.max(state.memory.nextNodeId || 0, nextId + 1);

  if (await saveState(state)) {
    manifest = updatedManifest;
    pendingQueue = [...remaining, ...overflow];
    saveManifest();
    savePending();
    const stillQueued = remaining.length + overflow.length;
    console.log(`Flushed ${readyItems.length} items (${reason}). ${stillQueued} still queued.`);
    // Auto-chain: keep draining backlog without waiting for next interval
    if (stillQueued > 0) {
      setTimeout(() => triggerFlush('drain'), 500);
    }
  } else {
    pendingQueue = [...snapshot, ...overflow];
    savePending();
  }

  flushInProgress = false;
}

function triggerFlush(reason) {
  runWithQueueLock(() => flushPending(reason));
}

function startWatchers() {
  if (!config.watch.length) {
    console.warn('No watch paths configured.');
  }

  config.watch.forEach((entry) => {
    const watchPath = resolvePath(entry.path);
    const globPart = entry.glob || '*';
    const watchTarget = entry.recursive
      ? path.join(watchPath, '**', globPart)
      : path.join(watchPath, globPart);
    const watcher = chokidar.watch(watchTarget, {
      ignoreInitial: true,  // Skip initial scan — pending queue already loaded from disk
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    watcher.on('add', (filePath) => {
      enqueueFile(filePath, entry);
    });
    watcher.on('change', (filePath) => {
      enqueueFile(filePath, entry);
    });
    watcher.on('error', (err) => {
      console.error(`Watcher error (${watchPath}): ${err.message}`);
    });
  });
}

function startScheduler() {
  if (Array.isArray(config.scheduled)) {
    config.scheduled.forEach((item) => {
      console.log(`Scheduled source ${item.source}: ${item.status || 'pending'}`);
    });
  }
}

function shutdown(signal) {
  console.log(`Shutting down (${signal})...`);
  triggerFlush('shutdown');
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`${memberName}-feeder starting. State: ${stateFile}`);
console.log(`Flush interval: ${flushIntervalMs / 1000}s, batch size: ${flushBatchSize}`);

async function scanWatchPaths() {
  let count = 0;
  for (const entry of config.watch) {
    const watchPath = require('path').resolve(entry.path.replace(/^~/, require('os').homedir()));
    if (!require('fs').existsSync(watchPath)) continue;
    const glob = entry.glob || '*';
    function walk(dir) {
      let entries;
      try { entries = require('fs').readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const full = require('path').join(dir, e.name);
        if (e.isDirectory()) { if (entry.recursive) walk(full); }
        else if (matchesGlob(full, glob)) { enqueueFile(full, entry); count++; }
      }
    }
    walk(watchPath);
  }
  console.log('Startup scan: ' + count + ' files checked against manifest');
}

startScheduler();
startWatchers();
setInterval(() => triggerFlush('interval'), flushIntervalMs);
// Startup: scan all watch paths for unmanifested files, then flush
scanWatchPaths().then(() => setTimeout(() => triggerFlush('startup'), 1000));
