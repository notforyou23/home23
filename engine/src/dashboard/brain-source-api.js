'use strict';

const express = require('express');
const fsp = require('node:fs').promises;
const {
  enrichEvidenceIdentity,
  sampleMemoryGraph,
  throwIfAborted,
  withEphemeralMemorySource,
  memorySourceError,
} = require('../../../shared/memory-source');

function requestAbortController(req) {
  const controller = new AbortController();
  req.once('close', () => controller.abort(Object.assign(new Error('request closed'), {
    name: 'AbortError',
    code: 'cancelled',
  })));
  return controller;
}

function pickGraphParameters(query = {}) {
  return {
    nodeLimit: query.nodeLimit ?? query.limit,
    edgeLimit: query.edgeLimit,
    clusterId: query.clusterId,
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
        const evidence = enrichEvidenceIdentity(source.getEvidence({
          completeCoverage: true,
          authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          returnedTotals: { nodes: 0, edges: 0 },
        }), context.identity);
        return {
          ok: evidence.sourceHealth !== 'unavailable',
          summary,
          evidence,
        };
      });
    },

    async graph(options = {}) {
      const { sourcePin = null, signal, identity, ...graphOptions } = options;
      throwIfAborted(signal);
      return withSource(sourcePin, { signal, identity }, async (source, context) => {
        const result = await sampleMemoryGraph(source, { ...graphOptions, signal });
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

function registerResidentBrainSourceRoutes(app, service) {
  app.get('/home23/api/brain/status', async (req, res) => {
    const controller = requestAbortController(req);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.status({ signal: controller.signal });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });

  app.get('/home23/api/brain/graph', async (req, res) => {
    const controller = requestAbortController(req);
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
    const controller = requestAbortController(req);
    try {
      rejectCallerIdentity(req.query || {});
      const result = await service.status({ signal: controller.signal });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });
  router.get('/graph', async (req, res) => {
    const controller = requestAbortController(req);
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
  rejectCallerIdentity,
  requestAbortController,
  sendBrainSourceError,
};
