'use strict';

const express = require('express');
const {
  assertIdentifier,
  assertOperationId,
  assertResultHandle,
} = require('./operation-contract.js');
const { OPERATION_AUTHORITY } = require('../../../../shared/brain-operations/authority.cjs');

const PUBLIC_BODY_LIMIT_BYTES = 1024 * 1024;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_QUERY_CHARS = 12_000;
const MAX_PRIOR_CONTEXT_CHARS = 20_000;
const QUERY_MODES = new Set([
  'quick', 'full', 'expert', 'dive', 'fast', 'normal', 'deep', 'executive',
  'raw', 'report', 'innovation', 'consulting', 'grounded',
]);
const PGS_MODES = new Set(['full', 'continue', 'targeted']);
const INTELLIGENCE_SECTIONS = new Set([
  'executive', 'goals', 'trajectory', 'thoughts', 'insights',
]);
const PARAMETER_FIELDS = Object.freeze({
  search: ['query', 'topK', 'tag'],
  graph: ['nodeLimit', 'edgeLimit', 'tag', 'clusterId', 'minWeight'],
  status: ['view', 'generationMarker'],
  query: [
    'query', 'mode', 'modelSelection', 'enablePGS', 'enableSynthesis',
    'includeOutputs', 'includeThoughts', 'includeCoordinatorInsights',
    'allowActions', 'priorContext', 'topK',
  ],
  pgs: ['query', 'mode', 'pgsMode', 'pgsConfig', 'pgsSweep', 'pgsSynth', 'priorContext'],
  graph_export: ['format'],
  synthesis: ['trigger', 'reason'],
  research_compile: ['kind', 'section', 'sectionId', 'focus'],
  research_launch: [
    'topic', 'context', 'cycles', 'explorationMode', 'analysisDepth',
    'maxConcurrent', 'primaryModel', 'primaryProvider', 'fastModel',
    'fastProvider', 'strategicModel', 'strategicProvider',
  ],
  research_continue: ['context', 'cycles', 'primaryModel', 'primaryProvider'],
  research_stop: [],
  research_watch: ['after', 'limit', 'filter'],
  research_intelligence: ['include'],
  ad_hoc_export: ['query', 'answer', 'format', 'metadata'],
});

function routeError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function httpStatusFor(error) {
  if (Number.isInteger(error?.httpStatus)) return error.httpStatus;
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.code === 'request_too_large') return 413;
  if (error?.code === 'access_denied') return 403;
  if (['operation_not_found', 'target_not_found', 'result_not_found'].includes(error?.code)) return 404;
  if (error?.code === 'result_expired') return 410;
  if (['idempotency_conflict', 'version_conflict', 'operation_terminal'].includes(error?.code)) return 409;
  if (['target_not_available', 'catalog_unavailable', 'source_unavailable',
    'executor_unavailable', 'operation_unavailable'].includes(error?.code)) return 503;
  if (['invalid_request', 'invalid_json', 'operation_id_invalid', 'identifier_invalid',
    'result_handle_invalid', 'event_cursor_invalid', 'brain_operations_route_not_found'].includes(error?.code)) return 400;
  return 500;
}

function sendError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'brain_operation_internal';
  const status = httpStatusFor(error);
  return res.status(status).json({
    ok: false,
    error: {
      code,
      message: typeof error?.message === 'string' ? error.message : code,
      httpStatus: status,
    },
  });
}

function exactObject(value, allowedKeys, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw routeError(code);
  const allowed = new Set(allowedKeys);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw routeError(code);
  }
  return value;
}

function boundedText(value, { required = false, max = 4096 } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw routeError('invalid_request');
  }
}

function boundedInteger(value, min, max) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw routeError('invalid_request');
  }
}

function boundedFinite(value, min, max) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw routeError('invalid_request');
  }
}

function optionalBoolean(value) {
  if (value !== undefined && typeof value !== 'boolean') throw routeError('invalid_request');
}

function exactProviderModelPair(value) {
  if (value === undefined) return;
  exactObject(value, ['provider', 'model']);
  if (Object.keys(value).length !== 2) throw routeError('invalid_request');
  boundedText(value.provider, { required: true, max: 256 });
  boundedText(value.model, { required: true, max: 256 });
}

function validatePriorContext(value) {
  if (value === undefined || value === null) return;
  exactObject(value, ['query', 'answer']);
  if (Object.keys(value).length !== 2
      || typeof value.query !== 'string'
      || typeof value.answer !== 'string'
      || value.query.length + value.answer.length > MAX_PRIOR_CONTEXT_CHARS) {
    throw routeError('invalid_request');
  }
}

function validateTargetSelector(policy, target, supplied) {
  if (policy.domain === 'requester') {
    if (supplied) throw routeError('invalid_request');
    return;
  }
  if (policy.domain === 'owned-run') {
    if (!supplied) throw routeError('invalid_request');
    exactObject(target, ['runId']);
    if (Object.keys(target).length !== 1) throw routeError('invalid_request');
    boundedText(target.runId, { required: true, max: 128 });
    try { assertIdentifier(target.runId, 'runId'); } catch { throw routeError('invalid_request'); }
    return;
  }
  if (!supplied) return;
  exactObject(target, ['agent', 'brainId']);
  if (Object.keys(target).length === 0) throw routeError('invalid_request');
  for (const field of ['agent', 'brainId']) {
    if (target[field] === undefined) continue;
    boundedText(target[field], { required: true, max: 256 });
    try { assertIdentifier(target[field], field); } catch { throw routeError('invalid_request'); }
  }
}

function validateProviderOverrides(parameters, pairs) {
  for (const [modelField, providerField] of pairs) {
    const hasModel = Object.hasOwn(parameters, modelField);
    const hasProvider = Object.hasOwn(parameters, providerField);
    if (hasModel !== hasProvider) throw routeError('invalid_request');
    if (hasModel) {
      boundedText(parameters[modelField], { required: true, max: 256 });
      boundedText(parameters[providerField], { required: true, max: 256 });
    }
  }
}

function validateParameters(operationType, parameters) {
  const fields = PARAMETER_FIELDS[operationType];
  if (!fields) throw routeError('invalid_request');
  exactObject(parameters, fields);

  if (['query', 'pgs', 'search'].includes(operationType)) {
    boundedText(parameters.query, { required: true, max: MAX_QUERY_CHARS });
  }
  if (operationType === 'query' || operationType === 'pgs') {
    if (parameters.mode !== undefined && !QUERY_MODES.has(parameters.mode)) {
      throw routeError('invalid_request');
    }
    validatePriorContext(parameters.priorContext);
  }
  if (operationType === 'query') {
    exactProviderModelPair(parameters.modelSelection);
    for (const field of [
      'enablePGS', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
      'includeCoordinatorInsights', 'allowActions',
    ]) optionalBoolean(parameters[field]);
    boundedInteger(parameters.topK, 1, 100);
  }
  if (operationType === 'pgs') {
    exactProviderModelPair(parameters.pgsSweep);
    exactProviderModelPair(parameters.pgsSynth);
    if (parameters.pgsMode !== undefined && !PGS_MODES.has(parameters.pgsMode)) {
      throw routeError('invalid_request');
    }
    if (parameters.pgsConfig !== undefined) {
      exactObject(parameters.pgsConfig, ['sweepFraction']);
      boundedFinite(parameters.pgsConfig.sweepFraction, Number.MIN_VALUE, 1);
    }
  }
  if (operationType === 'search') {
    boundedInteger(parameters.topK, 1, 100);
    boundedText(parameters.tag, { max: 256 });
  }
  if (operationType === 'graph') {
    boundedInteger(parameters.nodeLimit, 1, 2000);
    boundedInteger(parameters.edgeLimit, 1, 8000);
    boundedText(parameters.tag, { max: 256 });
    if (parameters.clusterId !== undefined
        && !((typeof parameters.clusterId === 'string' && parameters.clusterId.length <= 256)
          || (typeof parameters.clusterId === 'number'
            && Number.isSafeInteger(parameters.clusterId) && parameters.clusterId >= 0))) {
      throw routeError('invalid_request');
    }
    boundedFinite(parameters.minWeight, 0, 1);
  }
  if (operationType === 'status') {
    boundedText(parameters.view, { max: 256 });
    boundedText(parameters.generationMarker, { max: 256 });
  }
  if (operationType === 'graph_export' && parameters.format !== 'jsonl') {
    throw routeError('invalid_request');
  }
  if (operationType === 'synthesis') {
    boundedText(parameters.trigger, { max: 256 });
    boundedText(parameters.reason, { max: 4000 });
  }
  if (operationType === 'research_compile') {
    if (parameters.kind !== 'brain' && parameters.kind !== 'section') {
      throw routeError('invalid_request');
    }
    boundedText(parameters.focus, { max: MAX_QUERY_CHARS });
    if (parameters.kind === 'section') {
      boundedText(parameters.section, { required: true, max: 256 });
      boundedText(parameters.sectionId, { required: true, max: 256 });
    } else if (parameters.section !== undefined || parameters.sectionId !== undefined) {
      throw routeError('invalid_request');
    }
  }
  if (operationType === 'research_launch') {
    boundedText(parameters.topic, { required: true, max: MAX_QUERY_CHARS });
    boundedText(parameters.context, { max: MAX_PRIOR_CONTEXT_CHARS });
    boundedInteger(parameters.cycles, 1, 10_000);
    boundedInteger(parameters.maxConcurrent, 1, 64);
    if (parameters.explorationMode !== undefined
        && !['guided', 'autonomous'].includes(parameters.explorationMode)) {
      throw routeError('invalid_request');
    }
    if (parameters.analysisDepth !== undefined
        && !['shallow', 'normal', 'deep'].includes(parameters.analysisDepth)) {
      throw routeError('invalid_request');
    }
    validateProviderOverrides(parameters, [
      ['primaryModel', 'primaryProvider'], ['fastModel', 'fastProvider'],
      ['strategicModel', 'strategicProvider'],
    ]);
  }
  if (operationType === 'research_continue') {
    boundedText(parameters.context, { max: MAX_PRIOR_CONTEXT_CHARS });
    boundedInteger(parameters.cycles, 1, 10_000);
    validateProviderOverrides(parameters, [['primaryModel', 'primaryProvider']]);
  }
  if (operationType === 'research_watch') {
    boundedInteger(parameters.after, 0, Number.MAX_SAFE_INTEGER);
    boundedInteger(parameters.limit, 1, 500);
    boundedText(parameters.filter, { max: 256 });
  }
  if (operationType === 'research_intelligence' && parameters.include !== undefined) {
    if (!Array.isArray(parameters.include)
        || parameters.include.length > INTELLIGENCE_SECTIONS.size
        || new Set(parameters.include).size !== parameters.include.length
        || parameters.include.some((entry) => !INTELLIGENCE_SECTIONS.has(entry))) {
      throw routeError('invalid_request');
    }
  }
  if (operationType === 'ad_hoc_export') {
    boundedText(parameters.query, { required: true, max: MAX_QUERY_CHARS });
    boundedText(parameters.answer, { required: true, max: 1_000_000 });
    if (!['json', 'markdown'].includes(parameters.format)) throw routeError('invalid_request');
    if (parameters.metadata !== undefined) {
      exactObject(parameters.metadata, Object.keys(parameters.metadata));
      let encoded;
      try { encoded = JSON.stringify(parameters.metadata); } catch { throw routeError('invalid_request'); }
      if (Buffer.byteLength(encoded || '', 'utf8') > 64 * 1024) throw routeError('invalid_request');
    }
  }
}

function assertNoQuery(req) {
  if (Object.keys(req.query || {}).length !== 0) throw routeError('invalid_request');
}

function validateStartBody(body) {
  exactObject(body, ['requestId', 'operationType', 'target', 'parameters']);
  assertIdentifier(body.requestId, 'requestId');
  assertIdentifier(body.operationType, 'operationType');
  const policy = OPERATION_AUTHORITY[body.operationType];
  if (!policy) throw routeError('invalid_request');
  const hasTarget = Object.hasOwn(body, 'target');
  validateTargetSelector(policy, body.target, hasTarget);
  validateParameters(body.operationType, body.parameters);
  return {
    requestId: body.requestId,
    operationType: body.operationType,
    ...(Object.hasOwn(body, 'target') ? { target: body.target } : {}),
    parameters: body.parameters,
  };
}

function projectNonterminal(record) {
  return {
    operationId: record.operationId,
    requestId: record.requestId,
    operationType: record.operationType,
    requesterAgent: record.requesterAgent,
    target: record.target,
    state: record.state,
    phase: record.phase,
    recordVersion: record.recordVersion,
    eventSequence: record.eventSequence,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    lastProviderActivityAt: record.lastProviderActivityAt,
    lastProgressAt: record.lastProgressAt,
  };
}

function createBrainOperationsPlaceholderRouter(options = {}) {
  const limitBytes = options.limitBytes ?? PUBLIC_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw routeError('invalid_request');
  const router = express.Router();
  const parser = express.json({ limit: limitBytes, strict: true });
  let delegate = null;

  router.use((req, res, next) => {
    if (!BODY_METHODS.has(req.method)) return next();
    return parser(req, res, (error) => {
      if (error) {
        if (error.type === 'entity.too.large') return sendError(res, routeError('request_too_large', error));
        return sendError(res, routeError('invalid_json', error));
      }
      req.brainOperationBodyParsed = true;
      return next();
    });
  });
  router.use((req, res, next) => {
    if (!delegate) return sendError(res, routeError('operation_unavailable'));
    return delegate(req, res, next);
  });

  return Object.freeze({
    router,
    attach(nextRouter) {
      if (delegate || typeof nextRouter !== 'function') throw routeError('invalid_request');
      delegate = nextRouter;
    },
  });
}

function createBrainOperationsRouter(options = {}) {
  const {
    requesterAgent, coordinator, reader, exporter, buildCatalog,
  } = options;
  assertIdentifier(requesterAgent, 'requesterAgent');
  if (!coordinator || !reader || !exporter || typeof buildCatalog !== 'function') {
    throw routeError('invalid_request');
  }
  const router = express.Router();
  const asyncRoute = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.end();
    }
  };

  router.get('/catalog', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    res.json(await buildCatalog());
  }));

  router.get('/', asyncRoute(async (req, res) => {
    if (Object.keys(req.query || {}).length !== 1 || req.query.state !== 'nonterminal') {
      throw routeError('invalid_request');
    }
    const records = await reader.listNonterminalAuthorized();
    if (!Array.isArray(records)
        || records.some((record) => record?.requesterAgent !== requesterAgent
          || (record.state !== 'queued' && record.state !== 'running'))) {
      throw routeError('operation_store_corrupt');
    }
    res.json({ operations: records.map(projectNonterminal), count: records.length });
  }));

  router.post('/', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    const started = await coordinator.start(validateStartBody(req.body));
    if (started?.requesterAgent !== requesterAgent) throw routeError('operation_store_corrupt');
    res.status(202).json(started);
  }));

  router.get('/:operationId/events', asyncRoute(async (req, res) => {
    assertOperationId(req.params.operationId);
    const keys = Object.keys(req.query || {}).sort();
    if (keys.length !== 2 || keys[0] !== 'after' || keys[1] !== 'attachmentId') {
      throw routeError('invalid_request');
    }
    const afterText = String(req.query.after);
    if (!/^(0|[1-9]\d*)$/.test(afterText)) throw routeError('event_cursor_invalid');
    const after = Number(afterText);
    if (!Number.isSafeInteger(after)) throw routeError('event_cursor_invalid');
    const attachmentId = assertIdentifier(req.query.attachmentId, 'attachmentId');
    const controller = new AbortController();
    res.on('close', () => controller.abort(routeError('attachment_closed')));
    let streamReady = false;
    const pendingFrames = [];
    const formatEvent = (event) => {
      const sequence = event?.sequence ?? event?.eventSequence;
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw routeError('event_stream_invalid');
      assertIdentifier(event.type, 'eventType');
      return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    };
    const attachment = await coordinator.attach(req.params.operationId, {
      attachmentId,
      afterSequence: after,
      signal: controller.signal,
      onEvent(event) {
        if (res.writableEnded) return;
        const frame = formatEvent(event);
        if (!streamReady) pendingFrames.push(frame);
        else res.write(frame);
      },
    });
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.flushHeaders?.();
    streamReady = true;
    for (const frame of pendingFrames) res.write(frame);
    await attachment.done;
    if (!res.writableEnded) res.end();
  }));

  router.get('/:operationId/result', asyncRoute(async (req, res) => {
    assertOperationId(req.params.operationId);
    assertNoQuery(req);
    const operation = await reader.getAuthorized(req.params.operationId);
    const storedResult = await reader.getResultAuthorized(
      req.params.operationId,
      operation.resultHandle || undefined,
    );
    const result = operation.resultArtifact
      && storedResult?.result === null
      && storedResult?.resultHandle === operation.resultHandle
      ? null
      : storedResult;
    res.json({
      operationId: operation.operationId,
      state: operation.state,
      result,
      error: operation.error,
      resultHandle: operation.resultHandle,
      resultArtifact: operation.resultArtifact,
      sourceEvidence: operation.sourceEvidence,
    });
  }));

  router.post('/:operationId/cancel', asyncRoute(async (req, res) => {
    assertOperationId(req.params.operationId);
    assertNoQuery(req);
    exactObject(req.body, []);
    res.json(await coordinator.cancel(req.params.operationId));
  }));

  router.post('/:operationId/detach', asyncRoute(async (req, res) => {
    assertOperationId(req.params.operationId);
    assertNoQuery(req);
    exactObject(req.body, ['attachmentId', 'reason']);
    const input = {
      attachmentId: assertIdentifier(req.body.attachmentId, 'attachmentId'),
      reason: assertIdentifier(req.body.reason, 'reason'),
    };
    res.json(await coordinator.detach(req.params.operationId, input));
  }));

  router.post('/:operationId/export', asyncRoute(async (req, res) => {
    assertOperationId(req.params.operationId);
    assertNoQuery(req);
    exactObject(req.body, ['format', 'resultHandle', 'fileName']);
    assertIdentifier(req.body.format, 'format');
    if (req.body.resultHandle !== undefined) assertResultHandle(req.body.resultHandle);
    if (req.body.fileName !== undefined && typeof req.body.fileName !== 'string') {
      throw routeError('invalid_request');
    }
    res.json(await exporter.exportResult({
      requesterAgent,
      operationId: req.params.operationId,
      resultHandle: req.body.resultHandle,
      format: req.body.format,
      fileName: req.body.fileName,
    }));
  }));

  router.get('/:operationId', asyncRoute(async (req, res) => {
    assertOperationId(req.params.operationId);
    assertNoQuery(req);
    res.json(await reader.getAuthorized(req.params.operationId));
  }));

  router.use((req, res) => sendError(res, routeError('brain_operations_route_not_found')));
  return Object.freeze({ router });
}

module.exports = {
  PUBLIC_BODY_LIMIT_BYTES,
  createBrainOperationsPlaceholderRouter,
  createBrainOperationsRouter,
  routeError,
};
