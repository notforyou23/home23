const express = require('express');
const { promises: fsp } = require('node:fs');
const {
  enrichEvidenceIdentity,
  memorySourceError,
  sampleMemoryGraph,
  throwIfAborted,
  withEphemeralMemorySource
} = require('../../../shared/memory-source');

function requestAbortController(req) {
  const controller = new AbortController();
  req.once('close', () => controller.abort(Object.assign(new Error('request closed'), {
    name: 'AbortError',
    code: 'cancelled'
  })));
  return controller;
}

function pickGraphParameters(query = {}) {
  return {
    nodeLimit: query.nodeLimit ?? query.limit,
    edgeLimit: query.edgeLimit,
    clusterId: query.clusterId,
    minWeight: query.minWeight,
    full: query.full
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
    'scratchDir',
    'operationRoot',
    'lockRoot'
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw memorySourceError('invalid_request', 'source identity is server-derived', {
        status: 400,
        field: key
      });
    }
  }
}

function sendBrainSourceError(res, error) {
  if (error?.name === 'AbortError' || error?.code === 'cancelled') {
    return res.status(499).json({ success: false, ok: false, error: { code: 'cancelled' } });
  }
  const status = Number(error?.status) || (error?.code === 'invalid_request' ? 400
    : error?.code === 'result_too_large' ? 413
      : error?.code === 'source_changed' ? 409
        : 500);
  return res.status(status).json({
    success: false,
    ok: false,
    error: {
      code: error?.code || 'brain_source_failed',
      message: error.message,
      retryable: error.retryable === true
    }
  });
}

function createIdentity({ brain, requesterAgent, operationId }) {
  return {
    requesterAgent,
    targetAgent: brain.ownerAgent || null,
    brainId: brain.id || brain.routeKey || brain.name || null,
    canonicalRoot: brain.canonicalRoot || brain.path,
    catalogRevision: brain.catalogRevision || brain.catalogRevisionId || 'cosmo-catalog',
    kind: brain.kind || (brain.sourceType === 'resident' ? 'resident' : 'run'),
    sourceType: brain.sourceType || 'cosmo-brain',
    accessMode: brain.accessMode || (brain.ownerAgent === requesterAgent ? 'own' : 'read'),
    operationId
  };
}

function createBrainSourceRouter({
  resolveBrainBySelector,
  home23Root,
  requesterAgent = process.env.HOME23_AGENT || 'cosmo23',
  withSource = withEphemeralMemorySource
} = {}) {
  if (typeof resolveBrainBySelector !== 'function') {
    throw new Error('resolveBrainBySelector is required');
  }

  const router = express.Router();

  async function openBrainSource(req, callback) {
    rejectCallerIdentity(req.query || {});
    const brain = await resolveBrainBySelector(req.params.name);
    if (!brain) {
      throw memorySourceError('not_found', 'Brain not found', { status: 404, retryable: false });
    }
    if (!brain.path) {
      throw memorySourceError('source_unavailable', 'Brain path unavailable', { retryable: true });
    }
    const controller = requestAbortController(req);
    const canonicalRoot = await fsp.realpath(brain.path);
    const canonicalBrain = { ...brain, canonicalRoot };
    return withSource({
      brainDir: canonicalRoot,
      home23Root,
      requesterAgent,
      identity: {
        requesterAgent,
        targetAgent: brain.ownerAgent || null,
        brainId: brain.id || brain.routeKey || brain.name || null,
        catalogRevision: brain.catalogRevision || brain.catalogRevisionId || 'cosmo-catalog',
        kind: brain.kind || (brain.sourceType === 'resident' ? 'resident' : 'run'),
        sourceType: brain.sourceType || 'cosmo-brain',
        accessMode: brain.accessMode || (brain.ownerAgent === requesterAgent ? 'own' : 'read')
      },
      signal: controller.signal,
      prefix: 'cosmo-source'
    }, async (source, context) => callback({
      source,
      brain: canonicalBrain,
      signal: controller.signal,
      identity: createIdentity({ brain: canonicalBrain, requesterAgent, operationId: context.operationId })
    }));
  }

  router.get('/api/brain/:name/status', async (req, res) => {
    try {
      const result = await openBrainSource(req, async ({ source, signal, identity }) => {
        throwIfAborted(signal);
        const summary = await source.summarize({ signal });
        const evidence = enrichEvidenceIdentity(source.getEvidence({
          completeCoverage: true,
          authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          returnedTotals: { nodes: 0, edges: 0 }
        }), identity);
        return { ok: evidence.sourceHealth !== 'unavailable', summary, evidence };
      });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      return sendBrainSourceError(res, error);
    }
  });

  router.get('/api/brain/:name/graph', async (req, res) => {
    try {
      const result = await openBrainSource(req, async ({ source, signal, identity }) => {
        const sampled = await sampleMemoryGraph(source, { ...pickGraphParameters(req.query), signal });
        sampled.evidence = enrichEvidenceIdentity(sampled.evidence, identity);
        return {
          ...sampled,
          success: true
        };
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
  pickGraphParameters,
  rejectCallerIdentity,
  requestAbortController,
  sendBrainSourceError
};
