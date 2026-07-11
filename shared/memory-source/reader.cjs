'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { readJsonl } = require('./jsonl.cjs');
const { createBoundedOverlayStore } = require('./overlay-store.cjs');
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

function createDescriptor(canonicalRoot, manifest) {
  return Object.freeze({
    version: 1,
    canonicalRoot,
    generation: manifest.generation,
    baseRevision: manifest.baseRevision,
    cutoffRevision: manifest.currentRevision,
    activeBase: manifest.activeBase,
    activeDelta: manifest.activeDelta,
    summary: manifest.summary,
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

function unavailableSource(canonicalRoot, diagnostics = []) {
  const evidence = createEvidence({
    implementation: 'manifest-v1',
    identity: { canonicalRoot },
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
    for await (const entry of readJsonl(path.join(canonicalRoot, manifest.activeDelta.file), {
      byteLimit: manifest.activeDelta.committedBytes,
      confinedRoot: canonicalRoot,
      requireCompletePrefix: true,
      allowTrailingBytes: true,
      signal: options.signal,
    })) {
      throwIfAborted(options.signal);
      if (entry.epoch !== manifest.activeDeltaEpoch
          || entry.revision !== expectedRevision
          || entry.sequence !== expectedSequence) {
        throw memorySourceError('source_unavailable', 'committed delta is not contiguous', {
          retryable: true,
        });
      }
      await overlay.apply(entry);
      appliedRecords += 1;
      expectedRevision += 1;
      expectedSequence += 1;
    }
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
  const { overlay, appliedRecords } = await loadOverlay(canonicalRoot, manifest, options);
  const evidenceBase = {
    implementation: legacyProjection ? 'legacy-resident-sidecar-projection' : 'manifest-v1',
    identity: { canonicalRoot: logicalRoot, operationId: options.operationId || null },
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
      for await (const record of readJsonl(path.join(canonicalRoot, manifest.activeBase.edges.file), {
        gzip: true,
        confinedRoot: canonicalRoot,
        expectedInputBytes: manifest.activeBase.edges.bytes,
        expectedRecordCount: manifest.activeBase.edges.count,
        signal: options.signal,
      })) {
        throwIfAborted(options.signal);
        if (overlay.hasRemovedEdge(record) || overlay.hasRemovedNode(record.source)
            || overlay.hasRemovedNode(record.target)) continue;
        if (overlay.hasEdgeUpsert(record)) continue;
        yield Object.freeze({ ...record });
      }
      for (const record of overlay.upsertedEdges()) {
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
    getEvidence(input = {}) {
      return createEvidence({
        ...evidenceBase,
        ...input,
        sourceHealth,
        matchOutcome: input.matchOutcome || classifyMatchOutcome({
          sourceHealth,
          authoritativeTotal: manifest.summary.nodeCount,
          returnedTotal: input.returnedTotals?.nodes || 0,
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
    async searchKeyword({ query, topK = 10, tag = null, signal } = {}) {
      const tokens = normalizeKeywordTokens(query);
      const limit = parseBoundedInteger(topK, {
        name: 'topK', defaultValue: 10, min: 1, max: 100,
      });
      const exactTag = normalizeOptionalTag(tag);
      const results = [];
      let filtered = 0;
      let completeCoverage = true;
      for await (const node of this.iterateNodes({ signal })) {
        throwIfAborted(signal);
        const haystack = JSON.stringify({
          id: node.id,
          concept: node.concept,
          tag: node.tag,
          cluster: node.cluster,
        }).toLocaleLowerCase('en-US');
        if (tokens.some((token) => haystack.includes(token))) {
          if (exactTag !== null && node.tag !== exactTag) {
            filtered += 1;
            continue;
          }
          results.push({
            id: normalizeId(node.id),
            concept: typeof node.concept === 'string' ? node.concept.slice(0, 1024) : null,
            tag: node.tag ?? null,
          });
          if (results.length >= limit) {
            completeCoverage = false;
            break;
          }
        }
      }
      return {
        results,
        filtered,
        evidence: this.getEvidence({
          returnedTotals: { nodes: results.length, edges: 0 },
          completeCoverage,
          filteredTotal: filtered,
          filters: { tag: exactTag },
          limits: { topK: limit },
        }),
      };
    },
    isCurrent() {
      return legacyProjection
        ? verifyLegacySourceFingerprint(logicalRoot, legacyProjection)
        : true;
    },
    async compareAndSwap() { throw memorySourceError('invalid_request', 'writer not available'); },
    async release() { await this.close(); },
    async close() { await overlay.close(); },
  };
  Object.defineProperty(source, 'evidence', { get() { return source.getEvidence(); } });
  return source;
}

async function openMemorySource(brainDir, options = {}) {
  throwIfAborted(options.signal);
  const canonicalRoot = await fsp.realpath(brainDir);
  const manifest = options.pinnedManifest
    ? validateManifest(options.pinnedManifest)
    : await readManifest(canonicalRoot);
  try {
    if (manifest) return await openManifestSource(canonicalRoot, manifest, options);
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
      });
      return await openManifestSource(projected.projectionRoot, projected.manifest, {
        ...options,
        logicalCanonicalRoot: canonicalRoot,
        legacySourceFingerprint: projected.sourceFingerprint,
      });
    }
    return unavailableSource(canonicalRoot, ['source_missing']);
  } catch (error) {
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)) {
      if (error.code === 'source_unavailable' || error.code === 'invalid_memory_source') {
        return unavailableSource(canonicalRoot, [error.message]);
      }
      throw error;
    }
    return unavailableSource(canonicalRoot, [error.message || 'source_unavailable']);
  }
}

module.exports = {
  createDescriptor,
  enumerateMemoryMutationBoundaries,
  openMemorySource,
  resolveMemorySourceSelection,
};
