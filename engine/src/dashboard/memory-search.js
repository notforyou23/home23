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
  summarizeRetrievalAuthority,
  memorySourceError,
  rethrowAbort,
  throwIfAborted,
} = require('../../../shared/memory-source');
const {
  ANN_AUTHORITY_PROJECTION_SCHEMA,
  MAX_ANN_LABEL_BYTES,
  projectAnnLabel,
} = require('../../../shared/ann-label-contract.cjs');
const {
  classifyMemoryProvenance,
} = require('../memory/provenance-salience');
const {
  projectMemoryAuthority,
  projectMemoryRelations,
  createMemoryAuthorityResolver,
  hasAuthenticatedAuthorityEvidence,
} = require('../../../shared/memory-authority.cjs');
const {
  memoryAuthorityAttestationKeyId,
} = require('../../../shared/memory-authority-attestation.cjs');
const { createMemoryDeltaOverlayCache } = require('./memory-delta-overlay-cache');

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
  retrievalMode = 'logical-source-scan',
  maxRecordBytes = MAX_RECORD_BYTES,
} = {}) {
  const provenance = classifyMemoryProvenance(node);
  const publishedRetrievalScore = retrievalScore === null ? null : roundScore(retrievalScore);
  const carriedAuthority = Boolean(node?.retrievalAuthority);
  let retrievalAuthority = node?.retrievalAuthority || projectMemoryAuthority(node, {
    query: node?.retrievalQuery,
    trustedProjection: node?._trustedAuthorityProjection === true,
  });
  if (!carriedAuthority && publishedRetrievalScore !== null) {
    retrievalAuthority = {
      ...retrievalAuthority,
      scoreExplanation: {
        score: publishedRetrievalScore,
        factors: [{ name: 'base', value: publishedRetrievalScore }],
      },
    };
  }
  if (publishedRetrievalScore !== null && retrievalAuthority?.scoreExplanation) {
    const factors = Array.isArray(retrievalAuthority.scoreExplanation.factors)
      ? retrievalAuthority.scoreExplanation.factors
      : [];
    const explainedScore = factors.length > 0
      ? roundScore(factors.reduce((score, factor) => score * Number(factor?.value), 1))
      : null;
    if (explainedScore !== publishedRetrievalScore) {
      throw memorySourceError('source_unavailable', 'search candidate score explanation is inconsistent', {
        retryable: true,
      });
    }
    retrievalAuthority = {
      ...retrievalAuthority,
      scoreExplanation: {
        ...retrievalAuthority.scoreExplanation,
        score: publishedRetrievalScore,
        factors,
      },
    };
  }
  const row = {
    id: node?.id === undefined || node?.id === null ? null : String(node.id),
    concept: typeof node?.concept === 'string'
      ? truncateString(node.concept, 32 * 1024)
      : (typeof node?.content === 'string' ? truncateString(node.content, 32 * 1024) : null),
    tag: node?.tag ?? null,
    similarity: similarity === null ? undefined : roundScore(similarity),
    retrievalScore: publishedRetrievalScore === null ? undefined : publishedRetrievalScore,
    retrievalMode,
    sourceClass: provenance.sourceClass,
    salienceWeight: provenance.salienceWeight,
    retrievalDomain: retrievalAuthority.retrievalDomain,
    authorityClass: retrievalAuthority.authorityClass,
    semanticTime: retrievalAuthority.semanticTime,
    retrievalAuthority,
    authorityRelations: projectMemoryRelations(node, {
      trustedProjection: node?._trustedAuthorityProjection === true,
    }),
    ...(node?.resolutionEvidence ? { resolutionEvidence: node.resolutionEvidence } : {}),
    ...(node?.correctionEvidence ? { correctionEvidence: node.correctionEvidence } : {}),
    ...(node?.closureEvidence ? { closureEvidence: node.closureEvidence } : {}),
    ...(node?.supersessionEvidence ? { supersessionEvidence: node.supersessionEvidence } : {}),
    ...(node?._trustedAuthorityProjection === true
      ? { _trustedAuthorityProjection: true } : {}),
    status: node?.status ?? null,
    evidencePresent: typeof node?.evidencePresent === 'boolean' ? node.evidencePresent : null,
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
    return projectAnnLabel(label, { trustedProjection: true });
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
    if (header.authorityProjectionSchema !== ANN_AUTHORITY_PROJECTION_SCHEMA) {
      fail('ANN metadata authority projection schema does not match current trust policy');
    }
    const declaredCount = header.count;
    const includesSkippedLabels = header.labelCount !== undefined;
    const declaredLabelCount = header.labelCount ?? declaredCount;
    const skipped = header.skipped ?? 0;
    if (declaredCount !== undefined
        && (!Number.isSafeInteger(declaredCount) || declaredCount < 0)) {
      fail('ANN metadata label count is invalid');
    }
    if (!Number.isSafeInteger(skipped) || skipped < 0
        || (declaredLabelCount !== undefined
          && (!Number.isSafeInteger(declaredLabelCount) || declaredLabelCount < 0))
        || (includesSkippedLabels && declaredCount + skipped !== declaredLabelCount)) {
      fail('ANN metadata skipped count is invalid');
    }
    if (Number.isSafeInteger(expectedSourceNodeCount)
        && declaredCount + skipped !== expectedSourceNodeCount) {
      fail('ANN metadata count does not match source');
    }
    if (Number.isSafeInteger(header.sourceNodeCount)
        && header.sourceNodeCount !== declaredCount + skipped) {
      fail('ANN metadata source count is invalid');
    }
    expectedLabelCount = declaredLabelCount ?? null;
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

function createDefaultLoadAnn({ hnswlibLoader, indexRuntimeFactory, authorityKey } = {}) {
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
    let authorityAttestationKeyId;
    try {
      authorityAttestationKeyId = authorityKey === undefined
        ? memoryAuthorityAttestationKeyId()
        : memoryAuthorityAttestationKeyId(authorityKey);
    } catch (cause) {
      throw memorySourceError(
        'source_unavailable',
        'ANN authority verifier context is unavailable',
        {
          status: 503,
          retryable: true,
          annFallbackReason: 'ann_authority_context_unavailable',
          cause,
        },
      );
    }
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
        authorityAttestationKeyId,
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
        authorityAttestationKeyId,
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
    const currentSourceNodeCount = source?.descriptor?.summary?.nodeCount;
    const sourceNodeCount = annMeta.builtFromRevision === source?.revision
      ? currentSourceNodeCount
      : undefined;
    const meta = await parseAnnMetadataChunks(metaChunks, {
      expectedSourceNodeCount: sourceNodeCount,
      signal,
    });
    throwIfAborted(signal);
    if (meta.authorityAttestationKeyId !== authorityAttestationKeyId) {
      throw memorySourceError(
        'source_unavailable',
        'ANN authority verifier context does not match current trust policy',
        {
          status: 503,
          retryable: true,
          annFallbackReason: 'ann_authority_context_unavailable',
        },
      );
    }
    const dimension = meta.dimension || meta.dim;
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_EMBEDDING_DIMENSIONS) {
      throw memorySourceError('source_unavailable', 'ANN metadata dimension is invalid', {
        status: 503,
        retryable: true,
      });
    }
    const labels = meta.labels;
    const count = meta.count ?? labels?.length;
    const labelCount = meta.labelCount ?? count;
    if (!Array.isArray(labels) || !Number.isSafeInteger(count) || count < 0
        || !Number.isSafeInteger(labelCount) || labelCount < 0
        || labels.length !== labelCount) {
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
    const includesSkippedLabels = meta.labelCount !== undefined;
    if (!Number.isSafeInteger(skipped) || skipped < 0
        || (includesSkippedLabels && count + skipped !== labelCount)
        || (Number.isSafeInteger(meta.sourceNodeCount) && meta.sourceNodeCount !== count + skipped)
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
      skipped,
      includesSkippedLabels,
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
  for (const row of [...primary, ...keywordRows]) {
    const id = String(row.id);
    const normalized = { ...row, retrievalMode: row.retrievalMode || 'logical-source-scan' };
    const existing = merged.get(id);
    if (!existing
        || Number(normalized.retrievalScore ?? normalized.similarity ?? 0)
          > Number(existing.retrievalScore ?? existing.similarity ?? 0)) merged.set(id, normalized);
  }
  return Array.from(merged.values()).sort((left, right) => (
    Number(right.retrievalScore ?? right.similarity ?? 0)
      - Number(left.retrievalScore ?? left.similarity ?? 0)
    || String(left.id).localeCompare(String(right.id))
  )).slice(0, limit);
}

function keywordRelevance(node, tokens, query, tag) {
  if (!node || (tag && node.tag !== tag)) return 0;
  const haystack = JSON.stringify({
    id: node.id,
    concept: node.concept || node.content || '',
    tag: node.tag,
    cluster: node.cluster,
  }).toLocaleLowerCase('en-US');
  const matched = tokens.filter((token) => haystack.includes(token));
  if (matched.length === 0) return 0;
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('en-US');
  return (matched.length / tokens.length) + (normalizedQuery && haystack.includes(normalizedQuery) ? 1 : 0);
}

function authorityScoredCandidate(node, baseScore, options) {
  const retrievalAuthority = projectMemoryAuthority(node, { ...options, baseScore });
  return {
    retrievalScore: retrievalAuthority.scoreExplanation.score,
    retrievalBaseScore: baseScore,
    retrievalAuthority,
  };
}

function createMemorySearchService({
  brainDir,
  home23Root,
  requesterAgent,
  resolveTargetContext,
  embedQuery = createDefaultEmbedQuery(),
  loadAnn = createDefaultLoadAnn(),
  deltaOverlayCache = null,
  logger = console,
  withEphemeralSource = withEphemeralMemorySource,
} = {}) {
  const overlayCache = deltaOverlayCache || (home23Root && requesterAgent
    ? createMemoryDeltaOverlayCache({
      cacheRoot: path.join(home23Root, 'instances', requesterAgent, 'runtime', 'cache'),
    })
    : null);
  async function executeSearch(source, request) {
    const responseStartedAt = performance.now();
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
    const keywordTokens = normalizeKeywordTokens(query);
    const tag = normalizeOptionalTag(requestedTag);
    const limit = parseBoundedInteger(topK, {
      name: 'topK',
      defaultValue: 10,
      min: 1,
      max: 100,
    });
    const similarityThreshold = Number.isFinite(Number(minSimilarity)) ? Number(minSimilarity) : 0.4;
    const semanticNoiseFloor = Number.isFinite(Number(noiseFloor)) ? Number(noiseFloor) : 0.55;
    const authorityOptions = (node, trustedProjection = false) => ({
      query,
      intent: request.intent || query,
      trustedProjection,
    });
    const authorityResolver = createMemoryAuthorityResolver({
      intent: request.intent || query,
    });
    const offerAuthorityResolved = (heap, candidate, trustedProjection = false) => {
      const resolved = authorityResolver.apply([candidate], { trustedProjection })[0];
      if (!resolved) return;
      const { _trustedAuthorityProjection: _ignoredCallerTrust, ...plain } = resolved;
      heap.offer(trustedProjection
        ? { ...plain, _trustedAuthorityProjection: true }
        : plain);
    };
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
    const effectiveBaseRevision = Number.isSafeInteger(manifest?.baseRevision)
      ? manifest.baseRevision
      : manifest?.ann?.builtFromRevision;
    const annRevisionEligible = annAvailable
      && Number.isSafeInteger(manifest.ann?.builtFromRevision)
      && manifest.ann.builtFromRevision >= effectiveBaseRevision
      && manifest.ann.builtFromRevision <= manifest.currentRevision;
    let overlay = null;
    let overlayFailure = null;
    const overlayStartedAt = performance.now();
    if (annRevisionEligible && !annFresh && overlayCache) {
      try {
        overlay = await overlayCache.refresh({
          canonicalRoot: source.descriptor?.canonicalRoot,
          manifest,
          signal,
        });
      } catch (error) {
        rethrowAbort(error, signal);
        overlayFailure = error;
        logger.warn?.('memory search delta overlay unavailable; using logical scan', error.message);
      }
    }
    const overlayRefreshMs = performance.now() - overlayStartedAt;
    const annCovered = annRevisionEligible && (annFresh || Boolean(overlay
      && overlay.coveredThroughRevision === manifest.currentRevision));
    let queryEmbedding = null;
    let fallback = null;
    const embeddingStartedAt = performance.now();
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
    const embeddingMs = performance.now() - embeddingStartedAt;

    const candidateLimit = Math.min(1000, Math.max(100, limit * 4));
    const semantic = createBoundedCandidateHeap({
      maxCount: candidateLimit,
      maxBytes: MAX_HEAP_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES,
    });
    const boundedKeyword = createBoundedCandidateHeap({
      maxCount: candidateLimit,
      maxBytes: MAX_HEAP_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES,
    });
    let logicalScanComplete = false;
    let logicalScanFiltered = 0;
    let logicalScanMs = 0;
    const runLogicalSourceScan = async ({ includeSemantic = false } = {}) => {
      if (logicalScanComplete) return;
      const scanStartedAt = performance.now();
      const logicalSemanticCandidates = createBoundedCandidateHeap({
        maxCount: candidateLimit,
        maxBytes: MAX_HEAP_BYTES,
        maxRecordBytes: MAX_RECORD_BYTES,
      });
      const logicalKeywordCandidates = createBoundedCandidateHeap({
        maxCount: candidateLimit,
        maxBytes: MAX_HEAP_BYTES,
        maxRecordBytes: MAX_RECORD_BYTES,
      });
      const projectLogicalCandidate = (node, baseScore, similarity = null) => {
        const retrievalAuthority = projectMemoryAuthority(node, {
          ...authorityOptions(node),
          baseScore,
        });
        return {
          ...node,
          similarity,
          retrievalScore: retrievalAuthority.scoreExplanation.score,
          retrievalAuthority,
          retrievalDomain: retrievalAuthority.retrievalDomain,
          authorityClass: retrievalAuthority.authorityClass,
          semanticTime: retrievalAuthority.semanticTime,
          sourceChain: retrievalAuthority.sourceChain,
          evidencePresent: hasAuthenticatedAuthorityEvidence(node),
          authorityRelations: projectMemoryRelations(node, { trustedProjection: false }),
          retrievalQuery: query,
          retrievalMode: 'logical-source-scan',
          _trustedAuthorityProjection: true,
        };
      };
      // Pass one selects only bounded query candidates. Authority events that
      // cannot affect one of those candidates must not consume the resolver's
      // bounded relation budget merely because they occur earlier on disk.
      for await (const node of source.iterateNodes({ signal })) {
        throwIfAborted(signal);
        const unfilteredKeywordRelevance = keywordRelevance(
          node, keywordTokens, query, null,
        );
        const keywordMatches = unfilteredKeywordRelevance > 0;
        const tagMatches = tag === null || node.tag === tag;
        if (keywordMatches && !tagMatches) logicalScanFiltered += 1;

        let similarity = null;
        const semanticMatches = includeSemantic && tagMatches
          && Array.isArray(node.embedding)
          && node.embedding.length === queryEmbedding?.length
          && Number.isFinite(similarity = cosineSimilarity(queryEmbedding, node.embedding))
          && similarity >= similarityThreshold;
        if (!semanticMatches && !(keywordMatches && tagMatches)) continue;
        if (semanticMatches) {
          logicalSemanticCandidates.offer(projectLogicalCandidate(node, similarity, similarity));
        }
        if (keywordMatches && tagMatches) {
          logicalKeywordCandidates.offer(projectLogicalCandidate(
            node,
            unfilteredKeywordRelevance,
          ));
        }
      }

      const semanticRows = logicalSemanticCandidates.sorted();
      const keywordRows = logicalKeywordCandidates.sorted();
      const relevantRelationRefs = new Set();
      for (const candidate of [...semanticRows, ...keywordRows]) {
        if (candidate.id !== null && candidate.id !== undefined) {
          relevantRelationRefs.add(`node:${String(candidate.id)}`);
        }
        for (const ref of candidate.authorityRelations?.refs || []) {
          relevantRelationRefs.add(ref);
        }
      }
      const logicalAuthorityResolver = createMemoryAuthorityResolver({
        intent: request.intent || query,
      });
      // Pass two observes only closures/corrections capable of changing the
      // retained candidates. Resolution and final heap insertion are deferred
      // until the pass ends, so physical source order cannot change the result.
      for await (const node of source.iterateNodes({ signal })) {
        throwIfAborted(signal);
        const relations = projectMemoryRelations(node, { trustedProjection: false });
        if (relations.refs.some(ref => relevantRelationRefs.has(ref))
            || relations.supersedes.some(ref => relevantRelationRefs.has(ref))) {
          logicalAuthorityResolver.observe(node, { trustedProjection: false });
        }
      }
      const publishResolved = (heap, rows) => {
        for (const candidate of rows) {
          throwIfAborted(signal);
          const resolved = logicalAuthorityResolver.apply(
            [candidate], { trustedProjection: true },
          )[0];
          if (resolved) heap.offer(resolved);
        }
      };
      publishResolved(semantic, semanticRows);
      publishResolved(boundedKeyword, keywordRows);
      logicalScanComplete = true;
      logicalScanMs = performance.now() - scanStartedAt;
    };
    let semanticRoute = 'none';
    let annUsed = false;
    let annLabelsAvailable = false;
    let annLabelCoverageIncomplete = false;
    let annSearchMs = 0;
    let annLoadMs = 0;
    let overlayScoringMs = 0;
    if (queryEmbedding && annRevisionEligible && annCovered && request.exhaustive !== true) {
      const consumeAnn = async (ann) => {
        if (!ann || Number(ann.dimension || ann.dim) !== queryEmbedding.length) return false;
        semanticRoute = annFresh ? 'semantic-ann' : 'semantic-ann-delta-overlay';
        if (Array.isArray(ann.labels)) {
          annLabelsAvailable = ann.count === undefined || ann.skipped === 0
            || ann.includesSkippedLabels === true
            || ann.labels.length === Number(ann.count || 0) + Number(ann.skipped || 0);
          if (annLabelsAvailable) {
            for (const label of ann.labels) {
              throwIfAborted(signal);
              if (overlay?.hasChangedNode(label?.id)) continue;
              authorityResolver.observe(label, { trustedProjection: true });
            }
          }
        }
        if (!annLabelsAvailable) {
          annLabelCoverageIncomplete = true;
          fallback = {
            route: 'logical-source-scan',
            reason: 'exact_canary_missing',
            completeness: 'complete',
          };
          return false;
        }
        if (overlay) {
          for (const node of overlay.nodeUpserts()) {
            throwIfAborted(signal);
            authorityResolver.observe(node, { trustedProjection: false });
          }
        }
        const annStartedAt = performance.now();
        for (const hit of await annSearchRows(ann, queryEmbedding, candidateLimit, { signal })) {
          throwIfAborted(signal);
          const node = hit.node || hit;
          if (!node) continue;
          if (overlay?.hasChangedNode(node.id)) continue;
          if (tag && node.tag !== tag) continue;
          const similarity = Number(hit.similarity);
          if (!Number.isFinite(similarity) || similarity < similarityThreshold) continue;
          offerAuthorityResolved(semantic, {
            ...node,
            similarity,
            ...authorityScoredCandidate(
              node, similarity, authorityOptions(node, true), { semantic: true },
            ),
            retrievalQuery: query,
            _trustedAuthorityProjection: true,
            retrievalMode: 'semantic-ann',
          }, true);
        }
        annSearchMs = performance.now() - annStartedAt;
        for (const label of ann.labels) {
          throwIfAborted(signal);
          if (overlay?.hasChangedNode(label?.id)) continue;
          const relevance = keywordRelevance(label, keywordTokens, query, tag);
          if (relevance <= 0) continue;
          offerAuthorityResolved(boundedKeyword, {
            ...label,
            ...authorityScoredCandidate(label, relevance, authorityOptions(label, true)),
            retrievalQuery: query,
            _trustedAuthorityProjection: true,
            retrievalMode: 'keyword-index-overlay',
          }, true);
        }
        if (overlay) {
          const scoreStartedAt = performance.now();
          for (const node of overlay.nodeUpserts()) {
            throwIfAborted(signal);
            if (tag && node.tag !== tag) continue;
            if (Array.isArray(node.embedding) && node.embedding.length === queryEmbedding.length) {
              const similarity = cosineSimilarity(queryEmbedding, node.embedding);
              if (similarity >= similarityThreshold) {
                offerAuthorityResolved(semantic, {
                  ...node,
                  similarity,
                  ...authorityScoredCandidate(
                    node, similarity, authorityOptions(node), { semantic: true },
                  ),
                  retrievalQuery: query,
                  retrievalMode: 'semantic-ann-delta-overlay',
                });
              }
            }
            const relevance = keywordRelevance(node, keywordTokens, query, tag);
            if (relevance > 0) {
              offerAuthorityResolved(boundedKeyword, {
                ...node,
                ...authorityScoredCandidate(node, relevance, authorityOptions(node)),
                retrievalQuery: query,
                retrievalMode: 'keyword-index-overlay',
              });
            }
          }
          overlayScoringMs = performance.now() - scoreStartedAt;
        }
        return true;
      };
      try {
        const annLoadStartedAt = performance.now();
        annUsed = typeof loadAnn.runExclusive === 'function'
          ? await loadAnn.runExclusive(source, manifest.ann, { signal }, consumeAnn)
          : await consumeAnn(await loadAnn(source, manifest.ann, { signal }));
        annLoadMs = performance.now() - annLoadStartedAt;
      } catch (error) {
        rethrowAbort(error, signal);
        if (error?.code !== 'ann_descriptor_unsupported'
            && error?.annFallbackReason !== 'ann_authority_context_unavailable') throw error;
        const reason = error?.annFallbackReason || 'ann_descriptor_unsupported';
        fallback = {
          route: 'logical-source-scan',
          reason,
          completeness: 'complete',
        };
      }
      if (!annUsed && !fallback) {
        fallback = { route: 'logical-keyword-scan', reason: 'embedding_dimension_mismatch', completeness: 'complete' };
      }
    } else if (request.exhaustive === true) {
      fallback = {
        route: 'logical-source-scan',
        reason: 'exhaustive_requested',
        completeness: 'complete',
      };
    } else if (queryEmbedding && !annCovered) {
      fallback = {
        route: 'logical-source-scan',
        reason: overlayFailure ? 'delta_overlay_unavailable' : (annAvailable ? 'ann_stale' : 'ann_missing'),
        completeness: 'complete',
      };
    }

    if (queryEmbedding && (request.exhaustive === true || !annCovered
        || ['embedding_dimension_mismatch', 'ann_descriptor_unsupported',
          'ann_authority_context_unavailable',
        ].includes(fallback?.reason) || annLabelCoverageIncomplete)) {
      semanticRoute = 'logical-source-scan';
      await runLogicalSourceScan({ includeSemantic: true });
    }

    const semanticCandidates = semantic.sorted().slice(0, limit);
    const semanticTop = semanticCandidates.filter((row) => Number(row.similarity || 0) >= semanticNoiseFloor);
    const indexedKeywordRows = boundedKeyword.sorted();
    if (summary.nodes > 0 && annUsed && annLabelsAvailable && semanticTop.length === 0
        && indexedKeywordRows.length === 0 && !fallback) {
      // Bounded ANN label text can prove a positive match, but truncation means
      // it can never prove exact absence. Use the logical source before saying
      // that the corpus has no match.
      fallback = {
        route: 'logical-source-scan', reason: 'exact_canary_missing', completeness: 'complete',
      };
    }
    const keywordStartedAt = performance.now();
    const logicalScanCompleteAtKeywordStart = logicalScanComplete;
    let keyword = null;
    let keywordRows;
    const keywordUsesIndex = annUsed && annLabelsAvailable
      && request.exhaustive !== true && fallback?.reason !== 'exact_canary_missing';
    if (keywordUsesIndex) {
      keywordRows = indexedKeywordRows.slice(0, limit);
    } else {
      await runLogicalSourceScan({ includeSemantic: false });
      keywordRows = boundedKeyword.sorted().slice(0, limit);
      keyword = {
        results: keywordRows,
        filtered: logicalScanFiltered,
        evidence: { completeCoverage: true },
      };
    }
    for (const row of keywordRows) authorityResolver.observe(row);
    const keywordScoringMs = (logicalScanCompleteAtKeywordStart ? logicalScanMs : 0)
      + (performance.now() - keywordStartedAt);
    const filteredTotal = Number.isSafeInteger(keyword?.filtered) && keyword.filtered >= 0
      ? keyword.filtered
      : 0;
    const completeCoverage = keywordUsesIndex
      ? annCovered
      : keyword?.evidence?.completeCoverage === true;
    const exactMissing = keywordRows.some((row) => !semanticTop.some((existing) => String(existing.id) === String(row.id)));
    if (!keywordUsesIndex && semanticCandidates.length > 0
        && semanticTop.length === 0 && keywordRows.length > 0 && !fallback) {
      fallback = { route: 'logical-source-scan', reason: 'semantic_noise_filtered', completeness: 'complete' };
    } else if (!keywordUsesIndex && exactMissing && !fallback) {
      fallback = { route: 'logical-source-scan', reason: 'exact_canary_missing', completeness: 'complete' };
    }
    const mergeStartedAt = performance.now();
    const mergedResults = mergeResults(semanticTop, keywordRows, limit);
    const mergeMs = performance.now() - mergeStartedAt;
    const baseEvidence = source.getEvidence();
    const degradesSourceHealth = Boolean(fallback);
    const sourceHealth = baseEvidence.sourceHealth === 'healthy' && degradesSourceHealth
      ? 'degraded'
      : baseEvidence.sourceHealth;
    const retrievalMode = fallback
      ? 'logical-source-scan'
      : semanticTop.length > 0
        ? semanticRoute
        : (keywordUsesIndex ? 'keyword-index-overlay' : 'logical-source-scan');
    const results = mergedResults.flatMap((row) => authorityResolver.apply(
      [row],
      { trustedProjection: row?._trustedAuthorityProjection === true },
    ))
      .map((row) => {
        const { _trustedAuthorityProjection, ...published } = row;
        return { ...published, retrievalMode };
      })
      .slice(0, limit);
    const authoritySummary = summarizeRetrievalAuthority(
      results.map(row => row.retrievalAuthority),
    );
    const outcomeHealth = sourceHealth === 'degraded'
      && completeCoverage && fallback?.completeness === 'complete'
      ? 'healthy'
      : sourceHealth;
    const matchOutcome = classifyMatchOutcome({
      sourceHealth: outcomeHealth,
      authoritativeTotal: summary.nodes,
      returnedTotal: results.length,
      filteredTotal,
      completeCoverage,
    });
    const indexCoverage = {
      complete: annUsed && annCovered,
      indexedRevision: manifest.ann?.builtFromRevision ?? null,
      currentRevision: manifest.currentRevision ?? null,
      coveredThroughRevision: annUsed && annCovered ? manifest.currentRevision : null,
      deltaRecords: overlay?.deltaRecords ?? manifest.activeDelta?.count ?? 0,
      distinctChangedNodes: overlay?.changedNodeCount ?? 0,
      distinctUpsertedNodes: overlay?.upsertedNodeCount ?? 0,
      distinctRemovedNodes: overlay?.removedNodeCount ?? 0,
      edgeOnlyRecords: overlay?.edgeOnlyRecords ?? 0,
      route: annUsed ? semanticRoute : fallback?.route || 'none',
      completeness: annUsed && annCovered ? 'complete' : fallback?.completeness || 'unknown',
    };
    const stageTimingsMs = {
      sourceOpen: Number.isFinite(source.openDurationMs) ? roundScore(source.openDurationMs) : 0,
      embedding: roundScore(embeddingMs),
      overlayRefresh: roundScore(overlayRefreshMs),
      annLoad: roundScore(annLoadMs),
      annSearch: roundScore(annSearchMs),
      overlayScoring: roundScore(overlayScoringMs),
      keywordScoring: roundScore(keywordScoringMs),
      merge: roundScore(mergeMs),
      response: roundScore(performance.now() - responseStartedAt),
    };
    const rawEvidence = source.getEvidence({
      identity,
      retrievalMode,
      indexCoverage,
      stageTimingsMs,
      authoritySummary,
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
        retrievalMode,
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
        retrievalMode,
        indexCoverage,
        stageTimingsMs,
        authoritySummary,
        stageTimings: {
          sourceOpenMs: Number.isFinite(source.openDurationMs) ? roundScore(source.openDurationMs) : null,
          embeddingMs: roundScore(embeddingMs),
          overlayRefreshMs: roundScore(overlayRefreshMs),
          annLoadMs: roundScore(annLoadMs),
          annSearchMs: roundScore(annSearchMs),
          overlayScoringMs: roundScore(overlayScoringMs),
          keywordScoringMs: roundScore(keywordScoringMs),
          mergeMs: roundScore(mergeMs),
          responseMs: roundScore(performance.now() - responseStartedAt),
        },
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
      nodeOverlayProvider: overlayCache,
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
