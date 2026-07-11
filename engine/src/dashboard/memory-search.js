'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
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
  classifyMemoryProvenance,
  scoreMemorySalience,
} = require('../memory/provenance-salience');

const MAX_EMBEDDING_DIMENSIONS = 8192;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_HEAP_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;

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
  return output;
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

function annSearchRows(ann, queryEmbedding, candidateLimit) {
  if (!ann) return [];
  if (typeof ann.search === 'function') return ann.search(queryEmbedding, candidateLimit) || [];
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

function createDefaultLoadAnn({ hnswlibLoader = () => require('hnswlib-node') } = {}) {
  return async function loadAnn(source, annMeta, { signal } = {}) {
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
    const root = await fs.realpath(canonicalRoot);
    const resolveRegular = async (basename, label) => {
      if (typeof basename !== 'string' || path.basename(basename) !== basename
          || basename === '.' || basename === '..') {
        throw memorySourceError('source_unavailable', `${label} path is invalid`, {
          status: 503,
          retryable: true,
        });
      }
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
    let metaBytes;
    if (anchoredIndex && anchoredMeta) {
      if (typeof anchoredIndex.path !== 'string' || anchoredIndex.path.length === 0
          || typeof anchoredMeta.readFile !== 'function'
          || typeof anchoredIndex.assertStable !== 'function'
          || typeof anchoredMeta.assertStable !== 'function') {
        throw memorySourceError('source_changed', 'ANN pinned handles are unavailable', {
          status: 503,
          retryable: true,
        });
      }
      indexPath = anchoredIndex.path;
      metaBytes = await anchoredMeta.readFile({ maxBytes: 16 * 1024 * 1024 });
    } else {
      const [{ filePath }, { filePath: metaPath, stat: metaStat }] = await Promise.all([
        resolveRegular(annMeta.indexFile, 'ANN index'),
        resolveRegular(annMeta.metaFile, 'ANN metadata'),
      ]);
      indexPath = filePath;
      if (metaStat.size > 16 * 1024 * 1024) {
        throw memorySourceError('result_too_large', 'ANN metadata exceeds byte limit', {
          status: 413,
          retryable: false,
        });
      }
      metaBytes = await fs.readFile(metaPath);
    }
    if (metaBytes.length > 16 * 1024 * 1024) {
      throw memorySourceError('result_too_large', 'ANN metadata exceeds byte limit', {
        status: 413,
        retryable: false,
      });
    }
    const meta = JSON.parse(metaBytes.toString('utf8'));
    throwIfAborted(signal);
    const dimension = meta.dimension || meta.dim;
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_EMBEDDING_DIMENSIONS) {
      throw memorySourceError('source_unavailable', 'ANN metadata dimension is invalid', {
        status: 503,
        retryable: true,
      });
    }
    const hnswlib = hnswlibLoader();
    const index = new hnswlib.HierarchicalNSW('cosine', dimension);
    index.readIndexSync(indexPath);
    if (anchoredIndex) {
      await Promise.all([anchoredIndex.assertStable(), anchoredMeta.assertStable()]);
    }
    index.setEf(Math.max(100, meta.efConstruction || 100));
    throwIfAborted(signal);
    return {
      dimension,
      count: meta.count,
      labels: meta.labels || [],
      index,
    };
  };
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
      const ann = await loadAnn(source, manifest.ann, { signal });
      if (ann && Number(ann.dimension || ann.dim) === queryEmbedding.length) {
        semanticRoute = 'semantic-ann';
        for (const hit of annSearchRows(ann, queryEmbedding, candidateLimit)) {
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
      } else {
        fallback = { route: 'logical-keyword-scan', reason: 'embedding_dimension_mismatch', completeness: 'complete' };
      }
    } else if (queryEmbedding && !annFresh) {
      fallback = {
        route: 'logical-source-scan',
        reason: annAvailable ? 'ann_stale' : 'ann_missing',
        completeness: 'complete',
      };
    }

    if (queryEmbedding && (!annFresh || fallback?.reason === 'embedding_dimension_mismatch')) {
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
    const exactMissing = keywordRows.some((row) => !semanticTop.some((existing) => String(existing.id) === String(row.id)));
    if (semanticCandidates.length > 0 && semanticTop.length === 0 && keywordRows.length > 0 && !fallback) {
      fallback = { route: 'logical-keyword-scan', reason: 'semantic_noise_filtered', completeness: 'complete' };
    } else if (exactMissing && !fallback) {
      fallback = { route: 'logical-keyword-supplement', reason: 'exact_canary_missing', completeness: 'complete' };
    }
    const results = mergeResults(semanticTop, keywordRows, limit);
    const baseEvidence = source.getEvidence();
    const degradesSourceHealth = fallback && fallback.reason !== 'ann_missing';
    const sourceHealth = baseEvidence.sourceHealth === 'healthy' && degradesSourceHealth
      ? 'degraded'
      : baseEvidence.sourceHealth;
    const matchOutcome = classifyMatchOutcome({
      sourceHealth,
      authoritativeTotal: summary.nodes,
      returnedTotal: results.length,
      filteredTotal: keywordRows.length,
      completeCoverage: true,
    });
    const rawEvidence = source.getEvidence({
      identity,
      completeCoverage: true,
      filters: { tag },
      limits: { topK: limit },
      authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
      returnedTotals: { nodes: results.length, edges: 0 },
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
  MAX_RECORD_BYTES,
  MAX_RESPONSE_BYTES,
  createBoundedCandidateHeap,
  createDefaultEmbedQuery,
  createDefaultLoadAnn,
  createMemorySearchService,
  cosineSimilarity,
  projectBoundedSearchNode,
};
