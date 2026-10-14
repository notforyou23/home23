'use strict';

const express = require('express');
const fsp = require('node:fs').promises;
const {
  enrichEvidenceIdentity,
  indexFreshnessStatus,
  listPgsPartitions,
  sampleMemoryGraph,
  throwIfAborted,
  withEphemeralMemorySource,
  memorySourceError,
  rethrowAbort,
} = require('../../../shared/memory-source');
const { annHasCompleteLabels, createDefaultLoadAnn } = require('./memory-search');

async function inspectIndexCoverage(source, { signal, loadAnn }) {
  const manifest = source.manifest;
  const baseEvidence = source.getEvidence();
  const ann = manifest?.ann;
  const available = manifest?.formatVersion === 1 && ann?.indexFile && ann?.metaFile;
  const eligible = available && Number.isSafeInteger(ann.builtFromRevision)
    && ann.builtFromRevision >= manifest.baseRevision
    && ann.builtFromRevision <= manifest.currentRevision;
  const covered = eligible && baseEvidence.sourceHealth === 'healthy'
    && baseEvidence.deltaWatermark?.revision === manifest.currentRevision
    && baseEvidence.deltaWatermark?.appliedRecords === manifest.activeDelta?.count;
  let usable = false;
  let unavailable = Boolean(available && !covered);
  if (covered) {
    try {
      // Use the same pinned native-index and metadata validation as search.
      // The dashboard shares this loader, so status reuses its resident cache.
      usable = annHasCompleteLabels(await loadAnn(source, ann, { signal }));
      unavailable = !usable;
    } catch (error) {
      rethrowAbort(error, signal);
      unavailable = true;
    }
  }
  const fresh = usable && ann.builtFromRevision === manifest.currentRevision;
  const route = usable ? (fresh ? 'semantic-ann' : 'semantic-ann-delta-overlay') : 'none';
  return {
    unavailable,
    retrievalMode: usable ? route : undefined,
    indexCoverage: {
      complete: usable,
      indexedRevision: ann?.builtFromRevision ?? null,
      currentRevision: manifest?.currentRevision ?? baseEvidence.deltaWatermark?.revision ?? null,
      coveredThroughRevision: usable ? manifest.currentRevision : null,
      deltaRecords: manifest?.activeDelta?.count ?? 0,
      route,
      completeness: usable ? 'complete' : 'unknown',
    },
  };
}

function requestAbortController(req, res) {
  const controller = new AbortController();
  const cleanup = () => {
    req.off('aborted', onRequestAborted);
    req.off('close', onRequestClose);
    res?.off('close', onResponseClose);
    res?.off('finish', cleanup);
  };
  const abort = (message) => {
    if (controller.signal.aborted) return;
    cleanup();
    controller.abort(Object.assign(new Error(message), {
      name: 'AbortError',
      code: 'cancelled',
    }));
  };
  const onRequestAborted = () => abort('request aborted');
  const onRequestClose = () => {
    if (req.aborted || req.complete !== true) abort('request closed before completion');
  };
  const onResponseClose = () => {
    if (res.writableEnded !== true) abort('response closed before completion');
  };
  req.once('aborted', onRequestAborted);
  req.once('close', onRequestClose);
  res?.once('close', onResponseClose);
  res?.once('finish', cleanup);
  if (req.aborted || (req.destroyed && req.complete !== true)) onRequestAborted();
  else if (res?.destroyed && res.writableEnded !== true) onResponseClose();
  return controller;
}

function pickGraphParameters(query = {}) {
  return {
    nodeLimit: query.nodeLimit ?? query.limit ?? query.topN,
    edgeLimit: query.edgeLimit,
    clusterId: query.clusterId,
    tag: query.tag,
    minWeight: query.minWeight,
    full: query.full,
  };
}

function rejectCallerIdentity(input = {}) {
  const forbidden = [
    'identity',
    'requester',
    'requesterAgent',
    'target',
    'targetAgent',
    'root',
    'canonicalRoot',
    'catalogRevision',
    'operationId',
    'brainDir',
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw memorySourceError('invalid_request', 'source identity is server-derived', {
        status: 400,
        field: key,
      });
    }
  }
}

function createBrainSourceService({
  brainDir,
  home23Root,
  requesterAgent,
  resolveTargetContext,
  withEphemeralSource = withEphemeralMemorySource,
  loadAnn = createDefaultLoadAnn(),
} = {}) {
  async function withSource(sourcePin, { signal, identity }, callback) {
    if (sourcePin) {
      if (!identity?.operationId) {
        throw memorySourceError('invalid_request', 'pinned operation identity required', { status: 400 });
      }
      return callback(sourcePin, { identity });
    }
    if (identity !== undefined) {
      throw memorySourceError('invalid_request', 'compatibility identity is server-derived', { status: 400 });
    }
    if (typeof resolveTargetContext !== 'function') {
      throw memorySourceError('invalid_request', 'resolveTargetContext required', { status: 400 });
    }
    const resolved = await resolveTargetContext({});
    const target = resolved.target;
    const canonicalBrainDir = await fsp.realpath(brainDir);
    if (target.canonicalRoot !== canonicalBrainDir) {
      throw memorySourceError('source_changed', 'local catalog target/source mismatch', {
        retryable: true,
      });
    }
    const baseIdentity = {
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
      identity: baseIdentity,
      signal,
      prefix: 'dashboard-source',
    }, callback);
  }

  return {
    async status({ sourcePin = null, signal, identity } = {}) {
      throwIfAborted(signal);
      return withSource(sourcePin, { signal, identity }, async (source, context) => {
        const summary = await source.summarize({ signal });
        const index = await inspectIndexCoverage(source, { signal, loadAnn });
        const rawEvidence = source.getEvidence({
          completeCoverage: true,
          authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          returnedTotals: { nodes: 0, edges: 0 },
          indexCoverage: index.indexCoverage,
          retrievalMode: index.retrievalMode,
        });
        const evidence = enrichEvidenceIdentity({
          ...rawEvidence,
          indexWatermark: {
            ...rawEvidence.indexWatermark,
            status: indexFreshnessStatus({
              ...rawEvidence.indexWatermark,
              indexCoverage: index.indexCoverage,
              unavailable: index.unavailable || rawEvidence.sourceHealth === 'unavailable',
            }),
          },
          indexCoverage: index.indexCoverage,
          ...(index.retrievalMode && { retrievalMode: index.retrievalMode }),
        }, context.identity);
        return {
          ok: evidence.sourceHealth !== 'unavailable',
          summary,
          evidence,
        };
      });
    },

    async close() { await loadAnn.close?.(); },

    async graph(options = {}) {
      const { sourcePin = null, signal, identity, ...graphOptions } = options;
      throwIfAborted(signal);
      return withSource(sourcePin, { signal, identity }, async (source, context) => {
        const initialEvidence = source.getEvidence();
        if (initialEvidence.sourceHealth === 'unavailable') {
          throw memorySourceError('source_unavailable', 'canonical brain source is unavailable', {
            status: 503,
            retryable: true,
            sourceEvidence: enrichEvidenceIdentity(initialEvidence, context.identity),
          });
        }
        const result = await sampleMemoryGraph(source, { ...graphOptions, signal });
        result.evidence = enrichEvidenceIdentity(result.evidence, context.identity);
        if (result.evidence.sourceHealth === 'unavailable') {
          throw memorySourceError('source_unavailable', 'canonical brain source became unavailable', {
            status: 503,
            retryable: true,
            sourceEvidence: result.evidence,
          });
        }
        return result;
      });
    },

    async pgsPartitions(options = {}) {
      const { sourcePin = null, signal, identity, ...partitionOptions } = options;
      throwIfAborted(signal);
      return withSource(sourcePin, { signal, identity }, async (source, context) => {
        const initialEvidence = source.getEvidence();
        if (initialEvidence.sourceHealth === 'unavailable') {
          throw memorySourceError('source_unavailable', 'canonical brain source is unavailable', {
            status: 503,
            retryable: true,
            sourceEvidence: enrichEvidenceIdentity(initialEvidence, context.identity),
          });
        }
        const result = await listPgsPartitions(source, { ...partitionOptions, signal });
        result.evidence = enrichEvidenceIdentity(result.evidence, context.identity);
        return result;
      });
    },
  };
}

function sendBrainSourceError(res, error) {
  if (error?.name === 'AbortError' || error?.code === 'cancelled') {
    return res.status(499).json({ ok: false, error: { code: 'cancelled' } });
  }
  const status = Number(error?.status) || (error?.code === 'invalid_request' ? 400
    : error?.code === 'result_too_large' ? 413
      : error?.code === 'source_changed' ? 409
        : ['source_unavailable', 'source_busy'].includes(error?.code) ? 503
        : 500);
  return res.status(status).json({
    ok: false,
    success: false,
    error: {
      code: error?.code || 'brain_source_failed',
      message: error.message,
      retryable: error.retryable === true,
    },
  });
}

function registerLegacyMemoryGraphRoute(app, service) {
  app.get('/api/memory', async (req, res) => {
    const controller = requestAbortController(req, res);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.graph({
        ...pickGraphParameters(req.query),
        signal: controller.signal,
      });
      const meta = result.meta || {};
      return res.json({
        nodes: result.nodes || [],
        edges: result.edges || [],
        clusters: result.clusters ?? null,
        totalNodes: meta.authoritativeNodeCount ?? null,
        totalEdges: meta.authoritativeEdgeCount ?? null,
        _liveJournalCount: 0,
        bounded: true,
        meta,
        evidence: result.evidence || null,
      });
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });
}

function registerResidentBrainSourceRoutes(app, service) {
  app.get('/home23/api/brain/status', async (req, res) => {
    const controller = requestAbortController(req, res);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.status({ signal: controller.signal });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });

  app.get('/home23/api/brain/graph', async (req, res) => {
    const controller = requestAbortController(req, res);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.graph({
        ...pickGraphParameters(req.query),
        signal: controller.signal,
      });
      return res.json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });
}

function createBrainSourceRouter({ service } = {}) {
  const router = express.Router();
  router.get('/status', async (req, res) => {
    const controller = requestAbortController(req, res);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.status({ signal: controller.signal });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });
  router.get('/graph', async (req, res) => {
    const controller = requestAbortController(req, res);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.graph({
        ...pickGraphParameters(req.query),
        signal: controller.signal,
      });
      return res.json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });
  return router;
}

module.exports = {
  createBrainSourceRouter,
  createBrainSourceService,
  pickGraphParameters,
  registerResidentBrainSourceRoutes,
  registerLegacyMemoryGraphRoute,
  rejectCallerIdentity,
  requestAbortController,
  sendBrainSourceError,
};
