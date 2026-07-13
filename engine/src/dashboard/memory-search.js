'use strict';

const nodeFs = require('node:fs');
const fs = nodeFs.promises;
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const v8 = require('node:v8');
const { fork } = require('node:child_process');
const {
  withEphemeralMemorySource,
  classifyMatchOutcome,
  parseBoundedInteger,
  normalizeKeywordTokens,
  memorySourceError,
  rethrowAbort,
  throwIfAborted,
} = require('../../../shared/memory-source');
const {
  MAX_ANN_LABEL_BYTES,
  projectAnnLabel,
} = require('../../../shared/ann-label-contract.cjs');
const {
  classifyMemoryProvenance,
  scoreMemorySalience,
} = require('../memory/provenance-salience');

const MAX_EMBEDDING_DIMENSIONS = 8192;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_HEAP_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ANN_METADATA_BYTES = 256 * 1024 * 1024;
const MAX_ANN_METADATA_HEADER_BYTES = 1024 * 1024;
const MAX_ANN_METADATA_SUFFIX_BYTES = 64 * 1024;
const MAX_ANN_LABELS_HARD = 500_000;
const ESTIMATED_RETAINED_BYTES_PER_ANN_LABEL = 1536;
const ANN_WORKER_READY_TIMEOUT_MS = 120_000;
const ANN_SEARCH_TIMEOUT_MS = 60_000;
const ANN_WORKER_PATH = path.join(__dirname, 'ann-index-worker.cjs');

function roundScore(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateString(value, maxBytes) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = value;
  while (Buffer.byteLength(output, 'utf8') > maxBytes && output.length > 0) {
    output = output.slice(0, Math.floor(output.length * 0.9));
  }
  // Force a compact backing store. V8 sliced strings may otherwise retain the
  // complete multi-kilobyte ANN label even though only a bounded prefix is kept.
  return Buffer.from(output, 'utf8').toString('utf8');
}

function projectBoundedSearchNode(node, {
  similarity = null,
  retrievalScore = null,
  retrievalMode = 'keyword',
  maxRecordBytes = MAX_RECORD_BYTES,
} = {}) {
  const provenance = classifyMemoryProvenance(node);
  const row = {
    id: node?.id === undefined || node?.id === null ? null : String(node.id),
    concept: typeof node?.concept === 'string'
      ? truncateString(node.concept, 32 * 1024)
      : (typeof node?.content === 'string' ? truncateString(node.content, 32 * 1024) : null),
    tag: node?.tag ?? null,
    similarity: similarity === null ? undefined : roundScore(similarity),
    retrievalScore: retrievalScore === null ? undefined : roundScore(retrievalScore),
    retrievalMode,
    sourceClass: provenance.sourceClass,
    salienceWeight: provenance.salienceWeight,
    weight: node?.weight ?? null,
    activation: node?.activation ?? null,
    cluster: node?.cluster ?? null,
    created: node?.created ?? null,
    accessed: node?.accessed ?? null,
    accessCount: node?.accessCount ?? null,
  };
  for (const key of Object.keys(row)) {
    if (row[key] === undefined) delete row[key];
  }
  if (utf8Bytes(row) > maxRecordBytes) {
    row.concept = truncateString(String(row.concept || ''), Math.max(1024, maxRecordBytes / 2));
  }
  if (utf8Bytes(row) > maxRecordBytes) {
    throw memorySourceError('result_too_large', 'search candidate exceeds byte limit', {
      status: 413,
      retryable: false,
    });
  }
  return row;
}

function createBoundedCandidateHeap({
  maxCount,
  maxBytes = MAX_HEAP_BYTES,
  maxRecordBytes = MAX_RECORD_BYTES,
} = {}) {
  const rows = [];
  let retainedBytes = 0;

  function sortRows() {
    rows.sort((left, right) => {
      const score = Number(right.retrievalScore ?? right.similarity ?? 0)
        - Number(left.retrievalScore ?? left.similarity ?? 0);
      return score || String(left.id).localeCompare(String(right.id));
    });
  }

  return {
    offer(input) {
      const row = projectBoundedSearchNode(input, {
        similarity: input.similarity,
        retrievalScore: input.retrievalScore,
        retrievalMode: input.retrievalMode,
        maxRecordBytes,
      });
      const bytes = utf8Bytes(row);
      if (bytes > maxRecordBytes) {
        throw memorySourceError('result_too_large', 'search candidate exceeds byte limit', {
          status: 413,
          retryable: false,
        });
      }
      rows.push(row);
      retainedBytes += bytes;
      sortRows();
      while (rows.length > maxCount || retainedBytes > maxBytes) {
        const removed = rows.pop();
        retainedBytes -= utf8Bytes(removed);
      }
    },
    sorted() {
      sortRows();
      return rows.slice();
    },
    get retainedBytes() {
      return retainedBytes;
    },
    get length() {
      return rows.length;
    },
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value) || value.length === 0) return { embedding: null, reason: 'embedding_invalid' };
  if (value.length > MAX_EMBEDDING_DIMENSIONS) {
    throw memorySourceError('result_too_large', 'query embedding exceeds dimension limit', {
      status: 413,
      retryable: false,
    });
  }
  if (value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    return { embedding: null, reason: 'embedding_invalid' };
  }
  return { embedding: value, reason: null };
}

async function annSearchRows(ann, queryEmbedding, candidateLimit, options = {}) {
  if (!ann) return [];
  if (typeof ann.search === 'function') {
    return await ann.search(queryEmbedding, candidateLimit, options) || [];
  }
  if (ann.index && typeof ann.index.searchKnn === 'function') {
    const knn = ann.index.searchKnn(queryEmbedding, candidateLimit);
    return (knn.neighbors || []).map((neighbor, index) => ({
      node: ann.labels?.[neighbor],
      similarity: 1 - Number(knn.distances?.[index] || 0),
    }));
  }
  return [];
}

function normalizeOptionalTag(tag) {
  if (tag === null || tag === undefined || tag === '') return null;
  if (typeof tag !== 'string' || tag.trim() !== tag
      || Buffer.byteLength(tag, 'utf8') > 1024) {
    throw memorySourceError('invalid_request', 'tag must be a bounded exact string', {
      status: 400,
      field: 'tag',
    });
  }
  return tag;
}

function createDefaultEmbedQuery({ getClient } = {}) {
  const resolveClient = getClient || (() => {
    const { getEmbeddingClient } = require('../core/openai-client');
    return getEmbeddingClient();
  });
  return async function embedQuery(query, { signal } = {}) {
    throwIfAborted(signal);
    const client = resolveClient();
    const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    const createParams = { model: embeddingModel, input: String(query).slice(0, 2000) };
    if (!(process.env.EMBEDDING_BASE_URL || '').includes('11434')) {
      createParams.encoding_format = 'float';
    }
    const response = await client.embeddings.create(createParams, signal ? { signal } : undefined);
    throwIfAborted(signal);
    return response?.data?.[0]?.embedding || null;
  };
}

function compactAnnLabel(label) {
  try {
    return projectAnnLabel(label);
  } catch (cause) {
    throw memorySourceError('source_unavailable', 'ANN metadata label is invalid', {
      status: 503,
      retryable: true,
      cause,
    });
  }
}

function heapSafeAnnLabelLimit() {
  const heapLimit = Number(v8.getHeapStatistics().heap_size_limit);
  const heapUsed = Number(process.memoryUsage().heapUsed);
  const available = Number.isFinite(heapLimit) && Number.isFinite(heapUsed)
    ? Math.max(0, heapLimit - heapUsed)
    : 0;
  const derived = Math.floor((available * 0.5) / ESTIMATED_RETAINED_BYTES_PER_ANN_LABEL);
  return Math.max(1, Math.min(MAX_ANN_LABELS_HARD, derived || 1));
}

async function parseAnnMetadataChunks(chunks, {
  maxBytes = MAX_ANN_METADATA_BYTES,
  maxLabels = heapSafeAnnLabelLimit(),
  expectedSourceNodeCount,
  signal,
} = {}) {
  if (!Number.isSafeInteger(maxLabels) || maxLabels < 0) {
    throw memorySourceError('invalid_request', 'ANN metadata label limit is invalid');
  }
  const decoder = new StringDecoder('utf8');
  const labels = [];
  let totalBytes = 0;
  let prefix = '';
  let header = null;
  let mode = 'prefix';
  let expectation = 'value';
  let afterComma = false;
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let labelParts = [];
  let labelBytes = 0;
  let suffix = '';
  let expectedLabelCount = null;

  const fail = (message, cause) => {
    throw memorySourceError('source_unavailable', message, {
      status: 503,
      retryable: true,
      ...(cause ? { cause } : {}),
    });
  };

  const finishLabel = () => {
    if (labels.length >= maxLabels
        || (expectedLabelCount !== null && labels.length >= expectedLabelCount)) {
      fail('ANN metadata label count exceeds declared or heap-safe limit');
    }
    const encoded = labelParts.join('');
    labelParts = [];
    labelBytes = 0;
    try {
      labels.push(compactAnnLabel(JSON.parse(encoded)));
    } catch (error) {
      if (error?.code === 'source_unavailable') throw error;
      fail('ANN metadata label is malformed', error);
    }
  };

  const appendLabelPart = (part) => {
    if (!part) return;
    labelBytes += Buffer.byteLength(part, 'utf8');
    if (!Number.isSafeInteger(labelBytes) || labelBytes > MAX_ANN_LABEL_BYTES) {
      fail('ANN metadata label exceeds byte limit');
    }
    labelParts.push(part);
  };

  const appendSuffix = (part) => {
    if (!part) return;
    suffix += part;
    if (Buffer.byteLength(suffix, 'utf8') > MAX_ANN_METADATA_SUFFIX_BYTES) {
      fail('ANN metadata suffix exceeds byte limit');
    }
  };

  const consumeArray = (text) => {
    let labelStart = collecting ? 0 : null;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (mode === 'suffix') {
        appendSuffix(text.slice(index));
        return;
      }
      if (collecting) {
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
        } else if (character === '"') {
          inString = true;
        } else if (character === '{' || character === '[') {
          depth += 1;
        } else if (character === '}' || character === ']') {
          depth -= 1;
          if (depth < 0) fail('ANN metadata label nesting is invalid');
          if (depth === 0) {
            appendLabelPart(text.slice(labelStart, index + 1));
            finishLabel();
            collecting = false;
            labelStart = null;
            expectation = 'delimiter';
            afterComma = false;
          }
        }
        continue;
      }
      if (/\s/.test(character)) continue;
      if (expectation === 'value') {
        if (character === ']' && labels.length === 0 && afterComma === false) {
          mode = 'suffix';
          appendSuffix(text.slice(index + 1));
          return;
        }
        if (character !== '{') fail('ANN metadata labels must contain objects');
        collecting = true;
        depth = 1;
        inString = false;
        escaped = false;
        labelStart = index;
        continue;
      }
      if (character === ',') {
        expectation = 'value';
        afterComma = true;
        continue;
      }
      if (character === ']') {
        mode = 'suffix';
        appendSuffix(text.slice(index + 1));
        return;
      }
      fail('ANN metadata labels delimiter is invalid');
    }
    if (collecting && labelStart !== null) appendLabelPart(text.slice(labelStart));
  };

  const consume = (text) => {
    if (!text) return;
    if (mode !== 'prefix') {
      consumeArray(text);
      return;
    }
    prefix += text;
    if (Buffer.byteLength(prefix, 'utf8') > MAX_ANN_METADATA_HEADER_BYTES) {
      fail('ANN metadata header exceeds byte limit');
    }
    const match = /"labels"\s*:\s*\[/.exec(prefix);
    if (!match) return;
    const headerText = `${prefix.slice(0, match.index)}"labels":[]}`;
    try {
      header = JSON.parse(headerText);
    } catch (error) {
      fail('ANN metadata header is malformed', error);
    }
    const declaredCount = header.count;
    const skipped = header.skipped ?? 0;
    if (declaredCount !== undefined
        && (!Number.isSafeInteger(declaredCount) || declaredCount < 0)) {
      fail('ANN metadata label count is invalid');
    }
    if (!Number.isSafeInteger(skipped) || skipped < 0) {
      fail('ANN metadata skipped count is invalid');
    }
    if (Number.isSafeInteger(expectedSourceNodeCount)
        && (declaredCount === undefined || declaredCount + skipped !== expectedSourceNodeCount)) {
      fail('ANN metadata count does not match source');
    }
    expectedLabelCount = declaredCount ?? null;
    if (expectedLabelCount !== null && expectedLabelCount > maxLabels) {
      fail('ANN metadata label count exceeds heap-safe limit');
    }
    mode = 'array';
    const rest = prefix.slice(match.index + match[0].length);
    prefix = '';
    consumeArray(rest);
  };

  try {
    for await (const chunk of chunks) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        throw memorySourceError('result_too_large', 'ANN metadata exceeds byte limit', {
          status: 413,
          retryable: false,
        });
      }
      consume(decoder.write(buffer));
    }
    consume(decoder.end());
  } catch (error) {
    rethrowAbort(error, signal);
    if (error?.code === 'source_unavailable' || error?.code === 'result_too_large') throw error;
    fail('ANN metadata is unreadable', error);
  }
  if (!header || collecting || mode !== 'suffix' || afterComma
      || !/^\s*}\s*$/.test(suffix)) {
    fail('ANN metadata is incomplete');
  }
  if (expectedLabelCount !== null && labels.length !== expectedLabelCount) {
    fail('ANN metadata label count is inconsistent');
  }
  header.labels = labels;
  return header;
}

function annWorkerError(message, payload) {
  return memorySourceError('source_unavailable', message, {
    status: 503,
    retryable: true,
    workerError: payload && typeof payload === 'object' ? {
      name: payload.name || null,
      message: payload.message || null,
      code: payload.code || null,
    } : null,
  });
}

function inheritedAnnIndex(indexPath) {
  const match = /^(?:\/dev\/fd|\/proc\/self\/fd)\/(\d+)$/.exec(indexPath);
  if (!match) return { childPath: indexPath, inheritedFd: null };
  const inheritedFd = Number(match[1]);
  if (!Number.isSafeInteger(inheritedFd) || inheritedFd < 0) {
    throw annWorkerError('ANN pinned descriptor is invalid');
  }
  const childPath = process.platform === 'darwin' ? '/dev/fd/4'
    : process.platform === 'linux' ? '/proc/self/fd/4' : null;
  if (!childPath) {
    throw memorySourceError(
      'ann_descriptor_unsupported',
      'ANN descriptor inheritance is unsupported on this platform',
      { status: 503, retryable: false },
    );
  }
  return { childPath, inheritedFd };
}

function createAnnWorkerRuntime({
  indexPath,
  dimension,
  ef,
  signal,
  forkImpl = fork,
  searchTimeoutMs = ANN_SEARCH_TIMEOUT_MS,
} = {}) {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(searchTimeoutMs) || searchTimeoutMs < 1 || searchTimeoutMs > 300_000) {
    throw memorySourceError('invalid_request', 'ANN search timeout is invalid');
  }
  const { childPath, inheritedFd } = inheritedAnnIndex(indexPath);
  return new Promise((resolve, reject) => {
    let ready = false;
    let closing = false;
    let settled = false;
    let exited = false;
    let nextRequestId = 1;
    let stderr = '';
    let resolveExit;
    const exitPromise = new Promise((resolveChildExit) => { resolveExit = resolveChildExit; });
    const pending = new Map();
    const stdio = ['ignore', 'ignore', 'pipe', 'ipc'];
    if (inheritedFd !== null) stdio.push(inheritedFd);
    const child = forkImpl(ANN_WORKER_PATH, [childPath, String(dimension), String(ef)], {
      stdio,
    });

    child.stderr?.on('data', (chunk) => {
      if (Buffer.byteLength(stderr, 'utf8') >= 64 * 1024) return;
      stderr += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(stderr, 'utf8') > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.reject(entry.abortError || error);
      }
      pending.clear();
    };
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      signal?.removeEventListener?.('abort', abortStart);
      terminateChild();
      void exitPromise.then(() => reject(error));
    };
    const terminateChild = () => {
      if (exited) return;
      child.kill('SIGKILL');
    };
    const abortStart = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error('ANN load aborted');
      if (!error.name || error.name === 'Error') error.name = 'AbortError';
      failStart(error);
    };
    const readyTimer = setTimeout(() => {
      failStart(annWorkerError('ANN index worker startup timed out'));
    }, ANN_WORKER_READY_TIMEOUT_MS);

    const runtime = {
      async search(embedding, candidateLimit, { signal: searchSignal } = {}) {
        throwIfAborted(searchSignal);
        if (closing || !ready || exited || !child.connected) {
          throw annWorkerError('ANN index worker is unavailable');
        }
        const id = nextRequestId;
        nextRequestId += 1;
        return new Promise((resolveSearch, rejectSearch) => {
          const abortSearch = () => {
            const entry = pending.get(id);
            if (!entry) return;
            const error = searchSignal?.reason instanceof Error
              ? searchSignal.reason : new Error('ANN search aborted');
            if (!error.name || error.name === 'Error') error.name = 'AbortError';
            entry.abortError = error;
            void runtime.terminate().catch(() => {});
          };
          let searchTimer = null;
          const cleanup = () => {
            clearTimeout(searchTimer);
            searchSignal?.removeEventListener?.('abort', abortSearch);
          };
          pending.set(id, {
            resolve: resolveSearch,
            reject: rejectSearch,
            cleanup,
            abortError: null,
          });
          searchTimer = setTimeout(() => {
            const entry = pending.get(id);
            if (!entry) return;
            entry.abortError = annWorkerError('ANN index worker search timed out');
            void runtime.terminate().catch(() => {});
          }, searchTimeoutMs);
          searchSignal?.addEventListener?.('abort', abortSearch, { once: true });
          if (searchSignal?.aborted) {
            abortSearch();
            return;
          }
          child.send({ type: 'search', id, embedding, candidateLimit }, (error) => {
            if (!error) return;
            const entry = pending.get(id);
            if (!entry) return;
            entry.abortError = annWorkerError('ANN index worker request failed', {
              name: error?.name,
              message: error?.message,
              code: error?.code,
            });
            void runtime.terminate().catch(() => {});
          });
        });
      },
      isHealthy() { return ready && !closing && !exited && child.connected; },
      async terminate() {
        if (closing) {
          await exitPromise;
          return;
        }
        closing = true;
        ready = false;
        clearTimeout(readyTimer);
        signal?.removeEventListener?.('abort', abortStart);
        terminateChild();
        await exitPromise;
        rejectPending(annWorkerError('ANN index worker was replaced'));
      },
    };

    child.on('message', (message) => {
      if (message?.type === 'ready') {
        if (settled) return;
        settled = true;
        ready = true;
        clearTimeout(readyTimer);
        signal?.removeEventListener?.('abort', abortStart);
        resolve(runtime);
        return;
      }
      if (message?.type === 'fatal') {
        ready = false;
        const detail = stderr.trim() ? `${message.error?.message || ''}; ${stderr.trim()}` : message.error?.message;
        const error = annWorkerError('ANN index worker failed to load the pinned index', {
          ...message.error,
          message: detail || null,
        });
        if (!settled) failStart(error);
        else {
          for (const entry of pending.values()) entry.abortError = error;
          void runtime.terminate().catch(() => {});
        }
        return;
      }
      if (!ready || !Number.isSafeInteger(message?.id)) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      entry.cleanup();
      if (message.type === 'search-error') {
        entry.reject(annWorkerError('ANN index worker search failed', message.error));
        return;
      }
      if (message.type !== 'result'
          || !Array.isArray(message.neighbors) || !Array.isArray(message.distances)
          || message.neighbors.length > 1000 || message.distances.length > 1000) {
        entry.reject(annWorkerError('ANN index worker returned an invalid result'));
        return;
      }
      entry.resolve({ neighbors: message.neighbors, distances: message.distances });
    });
    child.on('error', (error) => {
      const typed = annWorkerError('ANN index worker failed', {
        name: error?.name,
        message: error?.message,
        code: error?.code,
      });
      ready = false;
      if (!settled) failStart(typed);
      else {
        for (const entry of pending.values()) entry.abortError = typed;
        void runtime.terminate().catch(() => {});
      }
    });
    const handleChildExit = (code, exitSignal) => {
      if (exited) return;
      exited = true;
      ready = false;
      resolveExit();
      if (closing) return;
      const error = annWorkerError(
        `ANN index worker exited unexpectedly (${exitSignal || code})`,
        stderr.trim() ? { message: stderr.trim() } : null,
      );
      if (!settled) failStart(error);
      rejectPending(error);
    };
    child.on('exit', handleChildExit);
    // A spawn-level error may emit close without exit. Treat either event as
    // the OS reclamation boundary so startup/abort cannot wait forever.
    child.on('close', handleChildExit);
    signal?.addEventListener?.('abort', abortStart, { once: true });
  });
}

function createInProcessAnnRuntimeFactory(hnswlibLoader) {
  return async ({ indexPath, dimension, ef }) => {
    const hnswlib = hnswlibLoader();
    const index = new hnswlib.HierarchicalNSW('cosine', dimension);
    index.readIndexSync(indexPath);
    index.setEf(ef);
    let closed = false;
    return {
      index,
      async search(embedding, candidateLimit) {
        if (closed) throw annWorkerError('Injected ANN test runtime is closed');
        return index.searchKnn(embedding, candidateLimit);
      },
      async terminate() { closed = true; },
    };
  };
}

function createDefaultLoadAnn({ hnswlibLoader, indexRuntimeFactory } = {}) {
  const createIndexRuntime = indexRuntimeFactory
    || (hnswlibLoader ? createInProcessAnnRuntimeFactory(hnswlibLoader) : createAnnWorkerRuntime);
  // A dashboard normally serves one resident brain. Keep exactly one immutable,
  // pinned ANN resident so a 100MB+ label map and a large native HNSW index are
  // not reread and reallocated for every search. A cross-brain/revision switch
  // replaces the entry rather than accumulating indexes in memory.
  let cached = null;
  let residentRuntime = null;
  let loadTail = Promise.resolve();
  const cacheIsUsable = (key) => key && cached?.key === key
    && cached.value?.isRuntimeHealthy?.() === true;
  async function loadAnnNow(source, annMeta, { signal } = {}) {
    if (!annMeta?.indexFile || !annMeta?.metaFile) return null;
    throwIfAborted(signal);
    const canonicalRoot = source?.descriptor?.canonicalRoot;
    if (typeof canonicalRoot !== 'string' || !path.isAbsolute(canonicalRoot)) {
      throw memorySourceError('source_unavailable', 'ANN target root is unavailable', {
        status: 503,
        retryable: true,
      });
    }
    const anchoredIndex = source?.getAnchoredFile?.('ann-index') || null;
    const anchoredMeta = source?.getAnchoredFile?.('ann-meta') || null;
    if (Boolean(anchoredIndex) !== Boolean(anchoredMeta)) {
      throw memorySourceError('source_changed', 'ANN pinned handles are incomplete', {
        status: 503,
        retryable: true,
      });
    }
    const validateBasename = (basename, label) => {
      if (typeof basename !== 'string' || path.basename(basename) !== basename
          || basename === '.' || basename === '..') {
        throw memorySourceError('source_unavailable', `${label} path is invalid`, {
          status: 503,
          retryable: true,
        });
      }
    };
    validateBasename(annMeta.indexFile, 'ANN index');
    validateBasename(annMeta.metaFile, 'ANN metadata');
    const root = await fs.realpath(canonicalRoot);
    const pinnedCacheKey = anchoredIndex && anchoredMeta
      && anchoredIndex.identity && anchoredMeta.identity
      ? JSON.stringify({
        root,
        generation: source?.descriptor?.generation || null,
        revision: annMeta.builtFromRevision ?? source?.descriptor?.cutoffRevision ?? null,
        indexFile: annMeta.indexFile,
        metaFile: annMeta.metaFile,
        indexIdentity: anchoredIndex.identity,
        metaIdentity: anchoredMeta.identity,
      })
      : null;
    if (cacheIsUsable(pinnedCacheKey)) {
      await Promise.all([anchoredIndex.assertStable(), anchoredMeta.assertStable()]);
      throwIfAborted(signal);
      return cached.value;
    }
    const resolveRegular = async (basename, label) => {
      const filePath = path.join(root, basename);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || path.dirname(await fs.realpath(filePath)) !== root) {
        throw memorySourceError('source_unavailable', `${label} path is unsafe`, {
          status: 503,
          retryable: true,
        });
      }
      return { filePath, stat };
    };
    let indexPath;
    let metaChunks;
    let metaPathForStream = null;
    let effectiveCacheKey = pinnedCacheKey;
    if (anchoredIndex && anchoredMeta) {
      if (anchoredIndex.path === null || anchoredIndex.path === undefined) {
        throw memorySourceError(
          'ann_descriptor_unsupported',
          'ANN descriptor paths are unsupported by this runtime',
          { status: 503, retryable: false },
        );
      }
      if (typeof anchoredIndex.path !== 'string' || anchoredIndex.path.length === 0
          || typeof anchoredMeta.readFile !== 'function'
          || typeof anchoredIndex.assertStable !== 'function'
          || typeof anchoredMeta.assertStable !== 'function') {
        throw memorySourceError('source_changed', 'ANN pinned handles are unavailable', {
          status: 503,
          retryable: true,
        });
      }
      if (Number.isFinite(anchoredMeta.size)
          && anchoredMeta.size > MAX_ANN_METADATA_BYTES) {
        throw memorySourceError('result_too_large', 'ANN metadata exceeds byte limit', {
          status: 413,
          retryable: false,
        });
      }
      indexPath = anchoredIndex.path;
      if (typeof anchoredMeta.readChunks === 'function') {
        metaChunks = anchoredMeta.readChunks({ maxBytes: MAX_ANN_METADATA_BYTES });
      } else {
        metaChunks = [await anchoredMeta.readFile({ maxBytes: MAX_ANN_METADATA_BYTES })];
      }
    } else {
      const [indexView, metaView] = await Promise.all([
        resolveRegular(annMeta.indexFile, 'ANN index'),
        resolveRegular(annMeta.metaFile, 'ANN metadata'),
      ]);
      indexPath = indexView.filePath;
      metaPathForStream = metaView.filePath;
      if (metaView.stat.size > MAX_ANN_METADATA_BYTES) {
        throw memorySourceError('result_too_large', 'ANN metadata exceeds byte limit', {
          status: 413,
          retryable: false,
        });
      }
      effectiveCacheKey = JSON.stringify({
        root,
        generation: source?.descriptor?.generation || null,
        revision: annMeta.builtFromRevision ?? source?.descriptor?.cutoffRevision ?? null,
        indexFile: annMeta.indexFile,
        metaFile: annMeta.metaFile,
        indexIdentity: {
          dev: indexView.stat.dev,
          ino: indexView.stat.ino,
          size: indexView.stat.size,
          mtimeMs: indexView.stat.mtimeMs,
        },
        metaIdentity: {
          dev: metaView.stat.dev,
          ino: metaView.stat.ino,
          size: metaView.stat.size,
          mtimeMs: metaView.stat.mtimeMs,
        },
      });
    }
    if (cacheIsUsable(effectiveCacheKey)) {
      if (anchoredIndex) {
        await Promise.all([anchoredIndex.assertStable(), anchoredMeta.assertStable()]);
      }
      throwIfAborted(signal);
      return cached.value;
    }
    if (metaPathForStream) {
      metaChunks = nodeFs.createReadStream(metaPathForStream, { highWaterMark: 64 * 1024 });
    }
    const sourceNodeCount = source?.descriptor?.summary?.nodeCount;
    const meta = await parseAnnMetadataChunks(metaChunks, {
      expectedSourceNodeCount: sourceNodeCount,
      signal,
    });
    throwIfAborted(signal);
    const dimension = meta.dimension || meta.dim;
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_EMBEDDING_DIMENSIONS) {
      throw memorySourceError('source_unavailable', 'ANN metadata dimension is invalid', {
        status: 503,
        retryable: true,
      });
    }
    const labels = meta.labels;
    const count = meta.count ?? labels?.length;
    if (!Array.isArray(labels) || !Number.isSafeInteger(count) || count < 0
        || labels.length !== count) {
      throw memorySourceError('source_unavailable', 'ANN metadata labels are inconsistent', {
        status: 503,
        retryable: true,
      });
    }
    if (meta.generation !== undefined && source?.descriptor?.generation
        && meta.generation !== source.descriptor.generation) {
      throw memorySourceError('source_changed', 'ANN metadata generation does not match source', {
        status: 503,
        retryable: true,
      });
    }
    if (meta.builtFromRevision !== undefined
        && meta.builtFromRevision !== annMeta.builtFromRevision) {
      throw memorySourceError('source_changed', 'ANN metadata revision does not match source', {
        status: 503,
        retryable: true,
      });
    }
    const skipped = meta.skipped ?? 0;
    if (!Number.isSafeInteger(skipped) || skipped < 0
        || (Number.isSafeInteger(sourceNodeCount) && count + skipped !== sourceNodeCount)) {
      throw memorySourceError('source_changed', 'ANN metadata count does not match source', {
        status: 503,
        retryable: true,
      });
    }
    cached = null;
    if (residentRuntime) {
      await residentRuntime.terminate();
      residentRuntime = null;
    }
    let nextRuntime = null;
    try {
      nextRuntime = await createIndexRuntime({
        indexPath,
        dimension,
        ef: Math.max(100, meta.efConstruction || 100),
        signal,
      });
      if (anchoredIndex) {
        await Promise.all([anchoredIndex.assertStable(), anchoredMeta.assertStable()]);
      }
      throwIfAborted(signal);
    } catch (error) {
      if (nextRuntime) await nextRuntime.terminate().catch(() => {});
      const workerCode = error?.workerError?.code || error?.code;
      if (anchoredIndex && ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(workerCode)) {
        throw memorySourceError(
          'ann_descriptor_unsupported',
          'ANN library cannot read an anchored descriptor path',
          { status: 503, retryable: false, cause: error },
        );
      }
      throw error;
    }
    residentRuntime = nextRuntime;
    const loaded = {
      dimension,
      count,
      labels,
      index: nextRuntime.index || null,
      isRuntimeHealthy() { return nextRuntime.isHealthy?.() !== false; },
      async search(embedding, candidateLimit, options = {}) {
        const knn = await nextRuntime.search(embedding, candidateLimit, options);
        return (knn.neighbors || []).map((neighbor, index) => ({
          node: labels[neighbor],
          similarity: 1 - Number(knn.distances?.[index] || 0),
        }));
      },
    };
    if (effectiveCacheKey) cached = { key: effectiveCacheKey, value: loaded };
    return loaded;
  }
  function enqueue(source, annMeta, options = {}, consumer = null) {
    // Serialize all misses, including cross-brain misses, so the one-entry cache
    // cannot transiently construct multiple ~500MB native indexes at once.
    const run = loadTail.then(async () => {
      const loaded = await loadAnnNow(source, annMeta, options);
      return typeof consumer === 'function' ? consumer(loaded) : loaded;
    });
    loadTail = run.catch(() => {});
    return run;
  }
  const loadAnn = (source, annMeta, options = {}) => enqueue(source, annMeta, options);
  loadAnn.runExclusive = (source, annMeta, options, consumer) => (
    enqueue(source, annMeta, options, consumer)
  );
  loadAnn.close = () => {
    const run = loadTail.then(async () => {
      cached = null;
      if (!residentRuntime) return;
      const closingRuntime = residentRuntime;
      residentRuntime = null;
      await closingRuntime.terminate();
    });
    loadTail = run.catch(() => {});
    return run;
  };
  return loadAnn;
}

function mergeResults(primary, keywordRows, limit) {
  const merged = new Map();
  for (const row of primary) merged.set(String(row.id), row);
  for (const row of keywordRows) {
    const id = String(row.id);
    if (!merged.has(id)) {
      merged.set(id, {
        ...row,
        retrievalMode: row.retrievalMode || 'keyword',
      });
    }
  }
  return Array.from(merged.values()).slice(0, limit);
}

function createMemorySearchService({
  brainDir,
  home23Root,
  requesterAgent,
  resolveTargetContext,
  embedQuery = createDefaultEmbedQuery(),
  loadAnn = createDefaultLoadAnn(),
  logger = console,
  withEphemeralSource = withEphemeralMemorySource,
} = {}) {
  async function executeSearch(source, request) {
    const {
      query,
      topK = 10,
      minSimilarity = 0.4,
      noiseFloor = 0.55,
      tag: requestedTag = null,
      signal,
      identity,
    } = request;
    throwIfAborted(signal);
    normalizeKeywordTokens(query);
    const tag = normalizeOptionalTag(requestedTag);
    const limit = parseBoundedInteger(topK, {
      name: 'topK',
      defaultValue: 10,
      min: 1,
      max: 100,
    });
    const similarityThreshold = Number.isFinite(Number(minSimilarity)) ? Number(minSimilarity) : 0.4;
    const semanticNoiseFloor = Number.isFinite(Number(noiseFloor)) ? Number(noiseFloor) : 0.55;
    const initialEvidence = source.getEvidence();
    if (initialEvidence.sourceHealth === 'unavailable') {
      throw memorySourceError('source_unavailable', 'canonical memory source is unavailable', {
        status: 503,
        retryable: true,
        sourceEvidence: initialEvidence,
      });
    }
    const summary = await source.summarize({ signal });
    const manifest = source.manifest;
    const annAvailable = manifest?.formatVersion === 1
      && Boolean(manifest.ann?.indexFile)
      && Boolean(manifest.ann?.metaFile);
    const annFresh = annAvailable && manifest.ann?.builtFromRevision === manifest.currentRevision;
    let queryEmbedding = null;
    let fallback = null;
    try {
      const embedded = await embedQuery(query, { signal });
      ({ embedding: queryEmbedding } = normalizeEmbedding(embedded));
      if (!queryEmbedding) {
        fallback = { route: 'logical-keyword-scan', reason: 'embedding_invalid', completeness: 'complete' };
      }
    } catch (error) {
      rethrowAbort(error, signal);
      if (error.code === 'result_too_large') throw error;
      logger.warn?.('memory search embedding unavailable; using keyword fallback', error.message);
      fallback = { route: 'logical-keyword-scan', reason: 'embedding_unavailable', completeness: 'complete' };
    }

    const candidateLimit = Math.min(1000, Math.max(100, limit * 4));
    const semantic = createBoundedCandidateHeap({
      maxCount: candidateLimit,
      maxBytes: MAX_HEAP_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES,
    });
    let semanticRoute = 'none';
    if (queryEmbedding && annFresh) {
      const consumeAnn = async (ann) => {
        if (!ann || Number(ann.dimension || ann.dim) !== queryEmbedding.length) return false;
        semanticRoute = 'semantic-ann';
        for (const hit of await annSearchRows(ann, queryEmbedding, candidateLimit, { signal })) {
          throwIfAborted(signal);
          const node = hit.node || hit;
          if (!node) continue;
          if (tag && node.tag !== tag) continue;
          const similarity = Number(hit.similarity);
          if (!Number.isFinite(similarity) || similarity < similarityThreshold) continue;
          semantic.offer({
            ...node,
            similarity,
            retrievalScore: scoreMemorySalience(node, similarity),
            retrievalMode: 'semantic-ann',
          });
        }
        return true;
      };
      let annUsed = false;
      try {
        annUsed = typeof loadAnn.runExclusive === 'function'
          ? await loadAnn.runExclusive(source, manifest.ann, { signal }, consumeAnn)
          : await consumeAnn(await loadAnn(source, manifest.ann, { signal }));
      } catch (error) {
        rethrowAbort(error, signal);
        if (error?.code !== 'ann_descriptor_unsupported') throw error;
        fallback = {
          route: 'logical-source-scan',
          reason: 'ann_descriptor_unsupported',
          completeness: 'complete',
        };
      }
      if (!annUsed && !fallback) {
        fallback = { route: 'logical-keyword-scan', reason: 'embedding_dimension_mismatch', completeness: 'complete' };
      }
    } else if (queryEmbedding && !annFresh) {
      fallback = {
        route: 'logical-source-scan',
        reason: annAvailable ? 'ann_stale' : 'ann_missing',
        completeness: 'complete',
      };
    }

    if (queryEmbedding && (!annFresh
        || ['embedding_dimension_mismatch', 'ann_descriptor_unsupported'].includes(fallback?.reason))) {
      semanticRoute = 'semantic-scan';
      for await (const node of source.iterateNodes({ signal })) {
        throwIfAborted(signal);
        if (tag && node.tag !== tag) continue;
        if (!Array.isArray(node.embedding) || node.embedding.length !== queryEmbedding.length) continue;
        const similarity = cosineSimilarity(queryEmbedding, node.embedding);
        if (similarity >= similarityThreshold) {
          semantic.offer({
            ...node,
            similarity,
            retrievalScore: scoreMemorySalience(node, similarity),
            retrievalMode: 'semantic-scan',
          });
        }
      }
    }

    const semanticCandidates = semantic.sorted().slice(0, limit);
    const semanticTop = semanticCandidates.filter((row) => Number(row.similarity || 0) >= semanticNoiseFloor);
    const keyword = await source.searchKeyword({ query, topK: limit, tag, signal });
    const keywordRows = (keyword.results || []).map((row) => ({
      ...row,
      retrievalMode: row.retrievalMode || 'keyword',
    }));
    const filteredTotal = Number.isSafeInteger(keyword.filtered) && keyword.filtered >= 0
      ? keyword.filtered
      : 0;
    const completeCoverage = keyword.evidence?.completeCoverage === true;
    const exactMissing = keywordRows.some((row) => !semanticTop.some((existing) => String(existing.id) === String(row.id)));
    if (semanticCandidates.length > 0 && semanticTop.length === 0 && keywordRows.length > 0 && !fallback) {
      fallback = { route: 'logical-keyword-scan', reason: 'semantic_noise_filtered', completeness: 'complete' };
    } else if (exactMissing && !fallback) {
      fallback = { route: 'logical-keyword-supplement', reason: 'exact_canary_missing', completeness: 'complete' };
    }
    const results = mergeResults(semanticTop, keywordRows, limit);
    const baseEvidence = source.getEvidence();
    const degradesSourceHealth = fallback
      && !['ann_missing', 'exact_canary_missing'].includes(fallback.reason);
    const sourceHealth = baseEvidence.sourceHealth === 'healthy' && degradesSourceHealth
      ? 'degraded'
      : baseEvidence.sourceHealth;
    const matchOutcome = classifyMatchOutcome({
      sourceHealth,
      authoritativeTotal: summary.nodes,
      returnedTotal: results.length,
      filteredTotal,
      completeCoverage,
    });
    const rawEvidence = source.getEvidence({
      identity,
      completeCoverage,
      filters: { tag },
      limits: { topK: limit },
      authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
      returnedTotals: { nodes: results.length, edges: 0 },
      filteredTotal,
    });
    const response = {
      query,
      results,
      stats: {
        totalSearched: summary.nodes,
        totalMatched: results.length,
        retrievalMode: fallback ? 'hybrid' : semanticRoute,
        salienceWeighted: true,
        noiseFiltered: semanticCandidates.length > 0 && semanticTop.length === 0,
      },
      evidence: {
        ...rawEvidence,
        sourceHealth,
        matchOutcome,
        filters: { tag },
        limits: { topK: limit },
        completeCoverage,
        filteredTotal,
        authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
        returnedTotals: { nodes: results.length, edges: 0 },
        fallback,
      },
    };
    if (utf8Bytes(response) > MAX_RESPONSE_BYTES) {
      throw memorySourceError('result_too_large', 'search response exceeds byte limit', {
        status: 413,
        retryable: false,
      });
    }
    return response;
  }

  async function search(request = {}) {
    throwIfAborted(request.signal);
    normalizeKeywordTokens(request.query);
    if (request.sourcePin) {
      if (!request.identity?.operationId) {
        throw memorySourceError('invalid_request', 'pinned operation identity required');
      }
      return executeSearch(request.sourcePin, request);
    }
    if (request.identity !== undefined) {
      throw memorySourceError('invalid_request', 'compatibility identity is server-derived');
    }
    if (typeof resolveTargetContext !== 'function') {
      throw memorySourceError('invalid_request', 'resolveTargetContext required');
    }
    const resolved = await resolveTargetContext({});
    const target = resolved.target;
    const canonicalBrain = await fs.realpath(brainDir);
    if (target.canonicalRoot !== canonicalBrain) {
      throw memorySourceError('source_changed', 'local catalog target/source mismatch', { retryable: true });
    }
    const identity = {
      requesterAgent,
      targetAgent: target.ownerAgent || target.requesterAgent || requesterAgent,
      brainId: target.id || target.brainId || requesterAgent,
      canonicalRoot: target.canonicalRoot,
      catalogRevision: resolved.catalogRevision,
      kind: target.kind || 'resident',
      sourceType: target.sourceType || 'brain',
      accessMode: resolved.accessMode || target.accessMode || 'own',
    };
    return withEphemeralSource({
      brainDir,
      home23Root,
      requesterAgent,
      identity,
      signal: request.signal,
      prefix: 'dashboard-search',
    }, (source, context) => executeSearch(source, {
      ...request,
      identity: context.identity,
    }));
  }

  return { search };
}

module.exports = {
  MAX_EMBEDDING_DIMENSIONS,
  MAX_HEAP_BYTES,
  MAX_ANN_METADATA_BYTES,
  MAX_RECORD_BYTES,
  MAX_RESPONSE_BYTES,
  createBoundedCandidateHeap,
  createAnnWorkerRuntime,
  createDefaultEmbedQuery,
  createDefaultLoadAnn,
  createMemorySearchService,
  cosineSimilarity,
  parseAnnMetadataChunks,
  projectBoundedSearchNode,
};
