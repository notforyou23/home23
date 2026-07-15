'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { readJsonl } = require('./jsonl.cjs');
const {
  applyOverlayEntriesInBatches,
  createBoundedOverlayStore,
} = require('./overlay-store.cjs');
const {
  readManifest,
  resolveMemorySourceSelection,
  validateManifest,
} = require('./manifest.cjs');
const {
  projectLegacyResidentSidecars,
  verifyLegacySourceFingerprint,
} = require('./legacy-projection.cjs');
const {
  SOURCE_HEALTH,
  MATCH_OUTCOME,
  normalizeId,
  normalizeKeywordTokens,
  parseBoundedInteger,
  edgeKeyFor,
  classifyMatchOutcome,
  createEvidence,
  sourceDescriptorDigest,
  memorySourceError,
  throwIfAborted,
  rethrowAbort,
  isTypedMemorySourceError,
} = require('./contracts.cjs');
const {
  assertMemorySourceInputSelection,
  resolveMemorySourceReadLimits,
} = require('./limits.cjs');
const {
  assertStableOpenedFileContent,
  portableFileIdentity,
  readOpenedFile,
} = require('./confined-file.cjs');
const {
  OPENED_JSONL_FILE,
  PINNED_OPENED_FILES,
} = require('./private-capabilities.cjs');
const {
  projectMemoryAuthority,
  projectMemoryRelations,
  scoreMemoryAuthority,
  createMemoryAuthorityResolver,
} = require('../memory-authority.cjs');
const { createDescriptor } = require('./descriptor.cjs');

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

function activeFiles(manifest) {
  return [
    manifest.activeBase.nodes.file,
    manifest.activeBase.edges.file,
    manifest.activeDelta.file,
    manifest.ann.indexFile,
    manifest.ann.metaFile,
  ].filter(Boolean);
}

async function closeOpenedFiles(openedFiles) {
  if (!(openedFiles instanceof Map)) return;
  await Promise.all([...new Set(openedFiles.values())].map(async (opened) => {
    await opened?.handle?.close().catch((error) => {
      if (error?.code !== 'EBADF') throw error;
    });
  }));
}

function anchoredFdPath(fd) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  return null;
}

function anchoredFileView(opened) {
  if (!opened) return null;
  return Object.freeze({
    path: anchoredFdPath(opened.handle.fd),
    size: Number(opened.stat.size),
    identity: portableFileIdentity(opened.stat),
    async *readChunks({ maxBytes, chunkBytes = 64 * 1024 } = {}) {
      const size = Number(opened.stat.size);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes
          || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) {
        throw memorySourceError('result_too_large', 'anchored file exceeds byte limit', {
          status: 413,
          retryable: false,
        });
      }
      let position = 0;
      while (position < size) {
        const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size - position));
        const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) {
          throw memorySourceError('source_changed', 'anchored file became truncated', {
            retryable: true,
          });
        }
        position += bytesRead;
        yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      }
      await assertStableOpenedFileContent(opened);
    },
    async readFile({ maxBytes } = {}) {
      return readOpenedFile(opened, { maxBytes });
    },
    async assertStable() {
      await assertStableOpenedFileContent(opened);
    },
  });
}

function enumerateMemoryMutationBoundaries(canonicalRoot, { extra = [] } = {}) {
  const defaults = new Map([
    ['brain', '.'],
    ['run', '.'],
    ['pgs', 'pgs-sessions'],
    ['session', 'sessions'],
    ['cache', 'cache'],
    ['export', 'exports'],
    ['agency', 'agency'],
  ]);
  for (const boundary of extra) {
    if (!defaults.has(boundary?.kind)) {
      throw memorySourceError('invalid_request', 'unknown mutation boundary');
    }
    defaults.set(boundary.kind, boundary.path);
  }
  return Object.freeze([...defaults.entries()]
    .map(([kind, relative]) => {
      const absolute = path.resolve(canonicalRoot, relative);
      const crossing = path.relative(canonicalRoot, absolute);
      if (crossing.startsWith('..') || path.isAbsolute(crossing)) {
        throw memorySourceError('invalid_request', 'mutation boundary escapes target');
      }
      return Object.freeze({ kind, path: absolute });
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)));
}

function evidenceIdentity(canonicalRoot, options = {}) {
  const supplied = options.identity;
  if (supplied !== undefined
      && (!supplied || Array.isArray(supplied) || typeof supplied !== 'object')) {
    throw memorySourceError('invalid_request', 'source evidence identity is invalid');
  }
  if (supplied?.canonicalRoot && supplied.canonicalRoot !== canonicalRoot) {
    throw memorySourceError('source_changed', 'source evidence root mismatch', { retryable: true });
  }
  if (supplied?.operationId && options.operationId
      && supplied.operationId !== options.operationId) {
    throw memorySourceError('source_changed', 'source evidence operation mismatch', { retryable: true });
  }
  return Object.freeze({
    ...(supplied || {}),
    canonicalRoot,
    operationId: options.operationId || supplied?.operationId || null,
  });
}

function unavailableSource(canonicalRoot, diagnostics = [], options = {}) {
  const evidence = createEvidence({
    implementation: 'manifest-v1',
    identity: evidenceIdentity(canonicalRoot, options),
    sourceHealth: SOURCE_HEALTH.UNAVAILABLE,
    matchOutcome: MATCH_OUTCOME.UNKNOWN,
    diagnostics,
  });
  return {
    descriptor: null,
    revision: null,
    manifest: null,
    physicalFiles: [],
    evidence,
    getEvidence() { return evidence; },
    getMutationBoundaries() { return enumerateMemoryMutationBoundaries(canonicalRoot); },
    async *iterateNodes() {},
    async *iterateEdges() {},
    async summarize() { return { nodes: 0, edges: 0, clusters: 0 }; },
    async summarizeBreakdowns() {
      return { tags: null, clusterTotals: null, omitted: true, scannedNodes: 0 };
    },
    async searchKeyword() { return { results: [], evidence }; },
    isCurrent() { return false; },
    async compareAndSwap() { throw memorySourceError('source_unavailable', 'source unavailable', { retryable: true }); },
    async release() {},
    async close() {},
  };
}

async function loadOverlay(canonicalRoot, manifest, options) {
  if (options.nodeOverlayProvider && !options.legacySourceFingerprint) {
    if (typeof options.nodeOverlayProvider.refresh !== 'function') {
      throw memorySourceError('invalid_request', 'node overlay provider is invalid');
    }
    try {
      const snapshot = await options.nodeOverlayProvider.refresh({
        canonicalRoot,
        manifest,
        signal: options.signal,
      });
      if (!snapshot || typeof snapshot.nodeUpserts !== 'function'
          || typeof snapshot.hasNodeUpsert !== 'function'
          || typeof snapshot.hasRemovedNode !== 'function'
          || !Number.isSafeInteger(snapshot.deltaRecords)
          || snapshot.deltaRecords !== manifest.activeDelta.count
          || snapshot.canonicalRoot !== canonicalRoot
          || snapshot.generation !== manifest.generation
          || snapshot.epoch !== manifest.activeDeltaEpoch
          || snapshot.baseRevision !== manifest.baseRevision
          || snapshot.coveredThroughRevision !== manifest.currentRevision
          || snapshot.committedBytes !== manifest.activeDelta.committedBytes) {
        throw memorySourceError('source_unavailable', 'node overlay coverage is incomplete', {
          retryable: true,
        });
      }
      const upserts = snapshot.nodeUpserts();
      if (!Array.isArray(upserts)) {
        throw memorySourceError('source_unavailable', 'node overlay upserts are invalid', {
          retryable: true,
        });
      }
      const nodeOnly = snapshot.coverage !== 'nodes-and-edges';
      let edgeUpserts = [];
      if (!nodeOnly) {
        if (typeof snapshot.upsertedEdges !== 'function'
            || typeof snapshot.iterateEdgeUpserts !== 'function'
            || typeof snapshot.hasEdgeUpsert !== 'function'
            || typeof snapshot.hasRemovedEdge !== 'function'
            || snapshot.committedChainDigest !== (manifest.activeDelta.chainDigest ?? null)
            || snapshot.chainBaseCount !== (manifest.activeDelta.chainBaseCount ?? null)
            || snapshot.chainBaseBytes !== (manifest.activeDelta.chainBaseBytes ?? null)
            || snapshot.chainBaseDigest !== (manifest.activeDelta.chainBaseDigest ?? null)) {
          throw memorySourceError('source_unavailable', 'edge overlay coverage is incomplete', {
            retryable: true,
          });
        }
        edgeUpserts = snapshot.upsertedEdges();
        if (!Array.isArray(edgeUpserts)) {
          throw memorySourceError('source_unavailable', 'edge overlay upserts are invalid', {
            retryable: true,
          });
        }
      }
      const overlay = {
        nodeOnly,
        hasRemovedNode(id) { return snapshot.hasRemovedNode(id); },
        hasNodeUpsert(id) { return snapshot.hasNodeUpsert(id); },
        hasRemovedEdge(value) { return nodeOnly ? false : snapshot.hasRemovedEdge(value); },
        hasEdgeUpsert(value) { return nodeOnly ? false : snapshot.hasEdgeUpsert(value); },
        upsertedEdges() { return edgeUpserts; },
        async *iterateEdgeUpserts({ signal } = {}) {
          if (nodeOnly) return;
          yield* snapshot.iterateEdgeUpserts({ signal });
        },
        async *iterateNodeUpserts() {
          for (const node of upserts) yield node;
        },
        async close() {},
      };
      return { overlay, appliedRecords: snapshot.deltaRecords };
    } catch (error) {
      rethrowAbort(error, options.signal);
      if (error?.code !== 'result_too_large') throw error;
      // A requester-owned acceleration cache is optional. Its private retained
      // state limit must not make the canonical logical source unavailable;
      // fall through to the complete bounded memory/disk overlay.
    }
  }
  const overlay = await createBoundedOverlayStore({
    operationRoot: options.operationRoot || null,
    scratchQuota: options.scratchQuota || null,
    signal: options.signal,
    maxMemoryBytes: options.maxOverlayMemoryBytes,
    maxDiskBytes: options.maxOverlayDiskBytes,
  });
  let appliedRecords = 0;
  let expectedRevision = manifest.baseRevision + 1;
  let expectedSequence = 1;
  try {
    assertMemorySourceInputSelection(
      manifest.activeDelta.committedBytes,
      options.maxInputBytes,
    );
    const validatedEntries = (async function* validatedEntries() {
      for await (const entry of readJsonl(
        path.join(canonicalRoot, manifest.activeDelta.file),
        {
          byteLimit: manifest.activeDelta.committedBytes,
          confinedRoot: canonicalRoot,
          maxDecompressedBytes: options.maxDecompressedBytes,
          requireCompletePrefix: true,
          allowTrailingBytes: true,
          [OPENED_JSONL_FILE]: options[PINNED_OPENED_FILES]?.get('delta'),
          signal: options.signal,
        },
      )) {
        throwIfAborted(options.signal);
        if (entry.epoch !== manifest.activeDeltaEpoch
            || entry.revision !== expectedRevision
            || entry.sequence !== expectedSequence) {
          throw memorySourceError('source_unavailable', 'committed delta is not contiguous', {
            retryable: true,
          });
        }
        appliedRecords += 1;
        expectedRevision += 1;
        expectedSequence += 1;
        yield entry;
      }
    })();
    await applyOverlayEntriesInBatches(overlay, validatedEntries, {
      signal: options.signal,
    });
    if (appliedRecords !== manifest.activeDelta.count
        || expectedRevision !== manifest.currentRevision + 1) {
      throw memorySourceError('source_unavailable', 'committed delta is incomplete', {
        retryable: true,
      });
    }
    return { overlay, appliedRecords };
  } catch (error) {
    await overlay.close().catch(() => {});
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)) throw error;
    throw memorySourceError('source_unavailable', 'committed delta is unreadable', {
      cause: error,
      retryable: true,
    });
  }
}

async function openManifestSource(canonicalRoot, manifest, options = {}) {
  const physicalRoot = canonicalRoot;
  const logicalRoot = options.logicalCanonicalRoot || canonicalRoot;
  const legacyProjection = options.legacySourceFingerprint || null;
  const descriptor = createDescriptor(logicalRoot, manifest);
  const openedFiles = options[PINNED_OPENED_FILES] || null;
  let overlay;
  let appliedRecords;
  try {
    ({ overlay, appliedRecords } = await loadOverlay(canonicalRoot, manifest, options));
  } catch (error) {
    await closeOpenedFiles(openedFiles);
    throw error;
  }
  const identity = evidenceIdentity(logicalRoot, options);
  const evidenceBase = {
    implementation: legacyProjection ? 'legacy-resident-sidecar-projection' : 'manifest-v1',
    identity,
    baseRevision: manifest.baseRevision,
    baseFile: manifest.activeBase.nodes.file,
    deltaRevision: manifest.currentRevision,
    deltaEpoch: manifest.activeDeltaEpoch,
    deltaApplied: appliedRecords,
    annBuiltFromRevision: manifest.ann.builtFromRevision,
    annFresh: manifest.ann.builtFromRevision === manifest.currentRevision,
    authoritativeTotals: {
      nodes: manifest.summary.nodeCount,
      edges: manifest.summary.edgeCount,
    },
    sourceHealth: legacyProjection ? SOURCE_HEALTH.DEGRADED : SOURCE_HEALTH.HEALTHY,
    matchOutcome: MATCH_OUTCOME.UNKNOWN,
    mutationBoundaries: enumerateMemoryMutationBoundaries(logicalRoot),
  };
  let sourceHealth = legacyProjection ? SOURCE_HEALTH.DEGRADED : SOURCE_HEALTH.HEALTHY;
  const markUnavailable = () => { sourceHealth = SOURCE_HEALTH.UNAVAILABLE; };
  const iterateBaseNodes = async function* iterateBaseNodes() {
    try {
      for await (const record of readJsonl(path.join(canonicalRoot, manifest.activeBase.nodes.file), {
        gzip: true,
        confinedRoot: canonicalRoot,
        expectedInputBytes: manifest.activeBase.nodes.bytes,
        expectedRecordCount: manifest.activeBase.nodes.count,
        maxInputBytes: options.maxInputBytes,
        maxDecompressedBytes: options.maxDecompressedBytes,
        [OPENED_JSONL_FILE]: openedFiles?.get('nodes'),
        signal: options.signal,
      })) {
        throwIfAborted(options.signal);
        const id = normalizeId(record.id);
        if (!id || overlay.hasRemovedNode(id)) continue;
        if (overlay.hasNodeUpsert(id)) continue;
        yield Object.freeze({ ...record, id });
      }
      for await (const record of overlay.iterateNodeUpserts({ signal: options.signal })) {
        yield record;
      }
    } catch (error) {
      markUnavailable();
      rethrowAbort(error, options.signal);
      if (isTypedMemorySourceError(error)) throw error;
      throw memorySourceError('source_unavailable', 'base nodes unavailable', {
        cause: error,
        retryable: true,
      });
    }
  };
  const iterateBaseEdges = async function* iterateBaseEdges() {
    try {
      if (overlay.nodeOnly) {
        throw memorySourceError(
          'source_operation_required',
          'node-search source does not expose edge overlay state',
          { retryable: false },
        );
      }
      for await (const record of readJsonl(path.join(canonicalRoot, manifest.activeBase.edges.file), {
        gzip: true,
        confinedRoot: canonicalRoot,
        expectedInputBytes: manifest.activeBase.edges.bytes,
        expectedRecordCount: manifest.activeBase.edges.count,
        maxInputBytes: options.maxInputBytes,
        maxDecompressedBytes: options.maxDecompressedBytes,
        [OPENED_JSONL_FILE]: openedFiles?.get('edges'),
        signal: options.signal,
      })) {
        throwIfAborted(options.signal);
        if (overlay.hasRemovedEdge(record) || overlay.hasRemovedNode(record.source)
            || overlay.hasRemovedNode(record.target)) continue;
        if (overlay.hasEdgeUpsert(record)) continue;
        yield Object.freeze({ ...record });
      }
      for await (const record of overlay.iterateEdgeUpserts({ signal: options.signal })) {
        if (!overlay.hasRemovedNode(record.source) && !overlay.hasRemovedNode(record.target)) yield record;
      }
    } catch (error) {
      markUnavailable();
      rethrowAbort(error, options.signal);
      if (isTypedMemorySourceError(error)) throw error;
      throw memorySourceError('source_unavailable', 'base edges unavailable', {
        cause: error,
        retryable: true,
      });
    }
  };
  const source = {
    descriptor,
    revision: manifest.currentRevision,
    manifest,
    physicalFiles: activeFiles(manifest).map((file) => path.join(physicalRoot, file)),
    maxBreakdownKeys: 0,
    getMutationBoundaries() { return enumerateMemoryMutationBoundaries(logicalRoot); },
    getAnchoredFile(role) {
      if (role !== 'ann-index' && role !== 'ann-meta') return null;
      return anchoredFileView(openedFiles?.get(role));
    },
    getEvidence(input = {}) {
      return createEvidence({
        ...evidenceBase,
        ...input,
        sourceHealth,
        freshness: legacyProjection ? 'unknown' : 'known',
        matchOutcome: input.matchOutcome || classifyMatchOutcome({
          sourceHealth,
          authoritativeTotal: manifest.summary.nodeCount,
          returnedTotal: input.returnedTotals?.nodes || 0,
          filteredTotal: input.filteredTotal || 0,
          completeCoverage: input.completeCoverage === true,
        }),
      });
    },
    iterateNodes: iterateBaseNodes,
    iterateEdges: iterateBaseEdges,
    async summarize() {
      return {
        nodes: descriptor.summary.nodeCount,
        edges: descriptor.summary.edgeCount,
        clusters: descriptor.summary.clusterCount,
      };
    },
    async summarizeBreakdowns({ maxKeys = 100, maxBytes = 64 * 1024 } = {}) {
      this.maxBreakdownKeys = maxKeys;
      return {
        tags: null,
        clusterTotals: null,
        omitted: true,
        scannedNodes: descriptor.summary.nodeCount,
        maxBytes,
      };
    },
    async searchKeyword({ query, topK = 10, tag = null, intent = null, signal } = {}) {
      const searchStartedAt = performance.now();
      const tokens = normalizeKeywordTokens(query);
      const limit = parseBoundedInteger(topK, {
        name: 'topK', defaultValue: 10, min: 1, max: 100,
      });
      const exactTag = normalizeOptionalTag(tag);
      const results = [];
      const resolver = createMemoryAuthorityResolver({
        intent: intent || query,
      });
      let filtered = 0;
      // Authority events can occur after a higher-scoring stale claim in the
      // physical source. Build the bounded relation index first so suppressed
      // rows never consume the caller's top-K heap.
      for await (const node of this.iterateNodes({ signal })) {
        throwIfAborted(signal);
        resolver.observe(node, { trustedProjection: false });
      }
      for await (const node of this.iterateNodes({ signal })) {
        throwIfAborted(signal);
        const haystack = JSON.stringify({
          id: node.id,
          concept: node.concept,
          tag: node.tag,
          cluster: node.cluster,
        }).toLocaleLowerCase('en-US');
        const matchedTokens = tokens.filter((token) => haystack.includes(token));
        if (matchedTokens.length > 0) {
          if (exactTag !== null && node.tag !== exactTag) {
            filtered += 1;
            continue;
          }
          const normalizedQuery = String(query || '').trim().toLocaleLowerCase('en-US');
          const keywordRelevance = (matchedTokens.length / tokens.length)
            + (normalizedQuery && haystack.includes(normalizedQuery) ? 1 : 0);
          const resolvedNode = resolver.apply([node])[0];
          if (!resolvedNode) continue;
          const retrievalAuthority = projectMemoryAuthority(resolvedNode, {
            baseScore: keywordRelevance,
            query,
            intent: intent || query,
          });
          results.push({
            id: normalizeId(resolvedNode.id),
            concept: typeof resolvedNode.concept === 'string'
              ? resolvedNode.concept.slice(0, 1024) : null,
            tag: resolvedNode.tag ?? null,
            status: resolvedNode.status ?? resolvedNode?.metadata?.status ?? null,
            retrievalMode: 'logical-source-scan',
            retrievalScore: scoreMemoryAuthority(resolvedNode, keywordRelevance, {
              query, intent: intent || query,
            }),
            retrievalDomain: retrievalAuthority.retrievalDomain,
            authorityClass: retrievalAuthority.authorityClass,
            semanticTime: retrievalAuthority.semanticTime,
            evidencePresent: retrievalAuthority.sourceChain.length > 0,
            authorityRelations: resolvedNode.authorityRelations
              || projectMemoryRelations(resolvedNode),
            ...(resolvedNode.resolutionEvidence
              ? { resolutionEvidence: resolvedNode.resolutionEvidence } : {}),
            ...(resolvedNode.correctionEvidence
              ? { correctionEvidence: resolvedNode.correctionEvidence } : {}),
            ...(resolvedNode.closureEvidence
              ? { closureEvidence: resolvedNode.closureEvidence } : {}),
            ...(resolvedNode.supersessionEvidence
              ? { supersessionEvidence: resolvedNode.supersessionEvidence } : {}),
            retrievalAuthority,
          });
          results.sort((left, right) => Number(right.retrievalScore || 0)
            - Number(left.retrievalScore || 0)
            || String(left.id).localeCompare(String(right.id)));
          if (results.length > limit) results.pop();
        }
      }
      const resolvedResults = results
        .sort((left, right) => Number(right.retrievalScore || 0)
          - Number(left.retrievalScore || 0)
          || String(left.id).localeCompare(String(right.id)))
        .slice(0, limit);
      const fallback = {
        route: 'logical-source-scan',
        reason: 'keyword_source_scan',
        completeness: 'complete',
      };
      const keywordScoring = Math.round((performance.now() - searchStartedAt) * 10000) / 10000;
      const indexCoverage = {
        complete: false,
        indexedRevision: manifest.ann?.indexFile && manifest.ann?.metaFile
          ? manifest.ann.builtFromRevision ?? null
          : null,
        currentRevision: manifest.currentRevision ?? null,
        coveredThroughRevision: null,
        route: 'logical-source-scan',
        completeness: 'complete',
      };
      const stageTimingsMs = {
        sourceOpen: 0,
        embedding: 0,
        overlayRefresh: 0,
        annLoad: 0,
        annSearch: 0,
        overlayScoring: 0,
        keywordScoring,
        merge: 0,
        response: keywordScoring,
      };
      const evidence = {
        ...this.getEvidence({
          returnedTotals: { nodes: resolvedResults.length, edges: 0 },
          completeCoverage: true,
          filteredTotal: filtered,
          filters: { tag: exactTag },
          limits: { topK: limit },
        }),
        sourceHealth: 'degraded',
        fallback,
        retrievalMode: 'logical-source-scan',
        indexCoverage,
        stageTimingsMs,
      };
      return {
        results: resolvedResults,
        filtered,
        evidence,
      };
    },
    isCurrent() {
      return legacyProjection
        ? verifyLegacySourceFingerprint(logicalRoot, legacyProjection)
        : true;
    },
    async compareAndSwap() { throw memorySourceError('invalid_request', 'writer not available'); },
    async release() { await this.close(); },
    async close() {
      let overlayError = null;
      try {
        await overlay.close();
      } catch (error) {
        overlayError = error;
      }
      try {
        await closeOpenedFiles(openedFiles);
      } catch (error) {
        if (overlayError === null) throw error;
      }
      if (overlayError !== null) throw overlayError;
    },
  };
  Object.defineProperty(source, 'evidence', { get() { return source.getEvidence(); } });
  return source;
}

async function openMemorySource(brainDir, options = {}) {
  const openedAt = performance.now();
  throwIfAborted(options.signal);
  const openedFiles = options[PINNED_OPENED_FILES] || null;
  let sourceLimits;
  let canonicalRoot = null;
  try {
    sourceLimits = resolveMemorySourceReadLimits({
      maxInputBytes: options.maxInputBytes,
      maxDecompressedBytes: options.maxDecompressedBytes,
      quotaMaxBytes: options.scratchQuota?.maxBytes,
    });
    canonicalRoot = await fsp.realpath(brainDir);
    const manifest = options.pinnedManifest
      ? validateManifest(options.pinnedManifest)
      : await readManifest(canonicalRoot);
    if (manifest) {
      const source = await openManifestSource(canonicalRoot, manifest, {
        ...options,
        ...sourceLimits,
      });
      Object.defineProperty(source, 'openDurationMs', {
        value: performance.now() - openedAt,
        enumerable: false,
      });
      return source;
    }
    const selection = await resolveMemorySourceSelection(canonicalRoot);
    if (selection.authority === 'legacy-resident-sidecars') {
      if (!options.operationRoot || !options.scratchQuota) {
        throw memorySourceError(
          'source_operation_required',
          'legacy source projection requires operation scratch',
          { retryable: false },
        );
      }
      const projected = await projectLegacyResidentSidecars({
        canonicalRoot,
        operationRoot: options.operationRoot,
        scratchQuota: options.scratchQuota,
        signal: options.signal,
        maxOverlayMemoryBytes: options.maxOverlayMemoryBytes,
        maxOverlayDiskBytes: options.maxOverlayDiskBytes,
        ...sourceLimits,
      });
      const projectionReadLimits = resolveMemorySourceReadLimits({
        quotaMaxBytes: options.scratchQuota.maxBytes,
      });
      return await openManifestSource(projected.projectionRoot, projected.manifest, {
        ...options,
        ...projectionReadLimits,
        logicalCanonicalRoot: canonicalRoot,
        legacySourceFingerprint: projected.sourceFingerprint,
      });
    }
    await closeOpenedFiles(openedFiles);
    return unavailableSource(canonicalRoot, ['source_missing'], options);
  } catch (error) {
    await closeOpenedFiles(openedFiles);
    if (canonicalRoot === null) throw error;
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)) {
      if (error.code === 'source_unavailable' || error.code === 'invalid_memory_source') {
        return unavailableSource(canonicalRoot, [error.message], options);
      }
      throw error;
    }
    return unavailableSource(canonicalRoot, [error.message || 'source_unavailable'], options);
  }
}

module.exports = {
  createDescriptor,
  enumerateMemoryMutationBoundaries,
  openMemorySource,
  resolveMemorySourceSelection,
};
