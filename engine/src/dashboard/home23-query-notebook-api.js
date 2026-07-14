'use strict';

const crypto = require('node:crypto');
const express = require('express');
const {
  assertIdentifier,
  assertOperationId,
} = require('./brain-operations/operation-contract.js');

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const ACTION_ORDER = Object.freeze([
  'openResult', 'continueSweep', 'targetedRetry', 'retryFresh', 'cancel', 'export', 'none',
]);
const EXECUTABLE_TOKEN_ACTIONS = new Set(['continueSweep', 'targetedRetry']);
const QUERY_REQUEST_ID_PATTERN = /^qreq_[A-Za-z0-9_-]{32}$/;
const RESULT_VERSION_PATTERN = /^qrv1_[A-Za-z0-9_-]{43}$/;
const EXPORT_FILENAME_PATTERN = /^home23-query-[A-Za-z0-9_-]{8}\.md$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPORT_CONTENT_MAX_BYTES = (1024 * 1024) + 64;

function apiError(code, httpStatus, retryable = false, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.httpStatus = httpStatus;
  error.retryable = retryable;
  return error;
}

function exactKeys(value, allowed, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw apiError(code, 400);
  const accepted = new Set(allowed);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw apiError(code, 400);
  }
  return value;
}

function sendError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'query_notebook_internal';
  const status = Number.isInteger(error?.httpStatus) ? error.httpStatus
    : code === 'access_denied' ? 403
      : ['operation_not_found', 'result_not_found', 'result_unavailable'].includes(code) ? 404
        : code === 'result_expired' ? 410
          : ['operation_terminal', 'idempotency_conflict'].includes(code) ? 409
            : ['operation_unavailable', 'query_notebook_auth_unavailable'].includes(code) ? 503
              : code === 'request_too_large' ? 413
                : code === 'invalid_request' || code.endsWith('_invalid') ? 400 : 500;
  return res.status(status).json({
    ok: false,
    error: { code, retryable: error?.retryable === true },
  });
}

function asyncRoute(handler) {
  return async (req, res) => {
    try { await handler(req, res); } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else if (!res.writableEnded) res.end();
    }
  };
}

function assertNoQuery(req) {
  if (Reflect.ownKeys(req.query || {}).length !== 0) throw apiError('invalid_request', 400);
}

function notebookPath(pathname) {
  return pathname === '/notebook' || pathname === '/session'
    || pathname === '/operations' || pathname.startsWith('/operations/');
}

function createQueryNotebookPlaceholderRouter(options = {}) {
  exactKeys(options, ['limitBytes']);
  const limitBytes = options.limitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw apiError('invalid_request', 400);
  const router = express.Router();
  const parser = express.json({ limit: limitBytes, strict: true });
  let delegate = null;

  router.use((req, res, next) => {
    if (!notebookPath(req.path)) return next();
    if (!BODY_METHODS.has(req.method)) return next();
    return parser(req, res, (error) => {
      if (error) {
        return sendError(res, error.type === 'entity.too.large'
          ? apiError('request_too_large', 413, false, error)
          : apiError('invalid_json', 400, false, error));
      }
      req.queryNotebookBodyParsed = true;
      return next();
    });
  });
  router.use((req, res, next) => {
    if (!notebookPath(req.path)) return next();
    if (!delegate) return sendError(res, apiError('operation_unavailable', 503, true));
    return delegate(req, res, next);
  });

  return Object.freeze({
    router,
    attach(nextRouter) {
      if (delegate || typeof nextRouter !== 'function') throw apiError('invalid_request', 400);
      delegate = nextRouter;
    },
  });
}

function listInput(query) {
  const keys = Reflect.ownKeys(query || {});
  const allowed = new Set(['limit', 'cursor', 'q', 'state', 'kind']);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw apiError('invalid_request', 400);
  }
  const input = {};
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string'
        || !/^(?:[1-9]|[1-9]\d|100)$/.test(query.limit)) {
      throw apiError('invalid_request', 400);
    }
    input.limit = Number(query.limit);
  }
  for (const key of ['cursor', 'q', 'kind', 'state']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      throw apiError('invalid_request', 400);
    }
  }
  if (query.cursor !== undefined) input.cursor = query.cursor;
  if (query.q !== undefined) input.q = query.q;
  if (query.kind !== undefined) input.requestKind = query.kind;
  if (query.state !== undefined) {
    const state = query.state;
    if (state === 'running' || state === 'finished') input.stateGroup = state;
    else input.executionState = state;
  }
  return input;
}

function waitForDrain(res, signal) {
  if (signal.aborted || res.writableEnded || res.destroyed) return Promise.resolve();
  if (typeof res.once !== 'function') throw apiError('event_stream_backpressure_unavailable', 500);
  return new Promise((resolve) => {
    const settle = () => {
      res.off?.('drain', settle);
      res.off?.('close', settle);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    res.once('drain', settle);
    res.once('close', settle);
    signal.addEventListener('abort', settle, { once: true });
  });
}

async function writeNotebookSseFrame(res, frame, signal) {
  if (signal.aborted || res.writableEnded || res.destroyed) return false;
  if (!res.write(frame)) await waitForDrain(res, signal);
  return !(signal.aborted || res.writableEnded || res.destroyed);
}

function sseFrame(type, sequence, value) {
  return `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function eventSequence(value) {
  const sequence = value?.sequence ?? value?.eventSequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw apiError('event_stream_invalid', 500);
  }
  return sequence;
}

const SAFE_PROGRESS_FIELDS = Object.freeze([
  'version', 'stage', 'sourceNodes', 'sourceEdges', 'candidateWorkUnits',
  'selected', 'completed', 'successful', 'failed', 'reused', 'pending', 'total',
  'synthesisLevel', 'synthesisBatch', 'synthesisBatches',
  'lastProviderActivityAt', 'lastProgressAt',
]);

function projectProgress(value, sequence) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw apiError('event_stream_invalid', 500);
  }
  const projected = {};
  for (const key of SAFE_PROGRESS_FIELDS) {
    if (Object.hasOwn(value, key)) projected[key] = value[key];
  }
  projected.eventSequence = sequence;
  return projected;
}

function projectStreamEvent(operationId, event) {
  const sequence = eventSequence(event);
  if (event.type === 'progress') {
    return {
      type: 'progress', sequence,
      value: {
        type: 'progress', operationId, eventSequence: sequence,
        progress: projectProgress(event.progressSnapshot ?? event.progress, sequence),
      },
    };
  }
  if (event.type === 'heartbeat') {
    return {
      type: 'heartbeat', sequence,
      value: {
        type: 'heartbeat', operationId, eventSequence: sequence,
        ...(typeof event.at === 'string' ? { at: event.at } : {}),
      },
    };
  }
  if (event.type === 'event_gap') {
    const fromSequence = event.oldestSequence;
    const toSequence = event.latestSequence;
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 0
        || !Number.isSafeInteger(toSequence) || toSequence < fromSequence) {
      throw apiError('event_stream_invalid', 500);
    }
    return {
      type: 'gap', sequence,
      value: {
        type: 'gap', operationId, eventSequence: sequence, fromSequence, toSequence,
      },
    };
  }
  const state = event.state ?? event.executionState;
  if ((event.type === 'state' || event.type === 'terminal') && TERMINAL_STATES.has(state)) {
    return {
      type: 'terminal', sequence,
      value: { type: 'terminal', operationId, eventSequence: sequence, executionState: state },
    };
  }
  return null;
}

function nextEventUntilAbort(attachment, signal) {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); resolve(null); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => attachment.nextEvent()).then((event) => {
      cleanup();
      resolve(event);
    }, (error) => {
      cleanup();
      if (signal.aborted) resolve(null);
      else reject(error);
    });
  });
}

function validateRequester(value, requesterAgent, operationId) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw apiError('notebook_projection_invalid', 500);
  }
  if (value.requesterAgent !== requesterAgent) throw apiError('access_denied', 403);
  if (operationId !== undefined && value.operationId !== operationId) {
    throw apiError('notebook_projection_invalid', 500);
  }
  return value;
}

function tokenActions(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw apiError('notebook_projection_invalid', 500);
  const actions = [];
  for (const entry of raw) {
    exactKeys(entry, ['kind', 'token', 'expiresAt'], 'notebook_projection_invalid');
    if (!EXECUTABLE_TOKEN_ACTIONS.has(entry.kind)
        || typeof entry.token !== 'string' || !entry.token || entry.token.length > 2048
        || typeof entry.expiresAt !== 'string'
        || !Number.isFinite(Date.parse(entry.expiresAt))
        || new Date(Date.parse(entry.expiresAt)).toISOString() !== entry.expiresAt) {
      throw apiError('notebook_projection_invalid', 500);
    }
    actions.push({ kind: entry.kind, token: entry.token, expiresAt: entry.expiresAt });
  }
  return actions;
}

function decorateActions(value, status = value, exportConfigured = false) {
  const projected = tokenActions(value.actions);
  const byKind = new Map(projected.map((action) => [action.kind, action]));
  if (status.resultAvailability === 'available') byKind.set('openResult', { kind: 'openResult' });
  if (exportConfigured
      && status.resultAvailability === 'available'
      && status.answerPreviewAvailable === true) {
    byKind.set('export', { kind: 'export' });
  }
  if (status.executionState === 'queued' || status.executionState === 'running') {
    byKind.set('cancel', { kind: 'cancel' });
  }
  if (byKind.size === 0) byKind.set('none', { kind: 'none' });
  return {
    ...value,
    actions: ACTION_ORDER.filter((kind) => byKind.has(kind)).map((kind) => byKind.get(kind)),
  };
}

function createHome23QueryNotebookRouter(options = {}) {
  exactKeys(options, [
    'requesterAgent', 'auth', 'notebookService', 'getStatusAuthorized', 'coordinator',
    'subscriptions', 'enqueueTerminalNotification',
  ]);
  let requesterAgent;
  try { requesterAgent = assertIdentifier(options.requesterAgent, 'requesterAgent'); } catch (error) {
    throw apiError('invalid_request', 400, false, error);
  }
  const { auth, notebookService, getStatusAuthorized, coordinator } = options;
  const exportConfigured = typeof notebookService?.exportQueryNotebookResultAuthorized === 'function';
  if (!auth || typeof auth.requireCredential !== 'function' || typeof auth.createSession !== 'function'
      || !notebookService
      || typeof notebookService.listQueryNotebookAuthorized !== 'function'
      || typeof notebookService.getQueryNotebookResultAuthorized !== 'function'
      || typeof notebookService.resolveAction !== 'function'
      || typeof getStatusAuthorized !== 'function'
      || !coordinator || typeof coordinator.cancel !== 'function'
      || typeof coordinator.attach !== 'function' || typeof coordinator.detach !== 'function') {
    throw apiError('invalid_request', 400);
  }
  const router = express.Router();

  async function status(operationId) {
    try { assertOperationId(operationId); } catch (error) {
      throw apiError('operation_id_invalid', 400, false, error);
    }
    return validateRequester(await getStatusAuthorized(operationId), requesterAgent, operationId);
  }

  async function loadActiveSubscriptions(identity, operationId) {
    if (identity?.requesterKind !== 'device'
        || !options.subscriptions
        || typeof options.subscriptions.listActive !== 'function') return [];
    const entries = await options.subscriptions.listActive(
      operationId === undefined ? {} : { operationId }
    );
    if (!Array.isArray(entries)) throw apiError('subscription_store_corrupt', 500);
    return entries;
  }

  async function decorateForRequest(value, identity, current = value, activeSubscriptions) {
    const decorated = decorateActions(value, current, exportConfigured);
    const entries = activeSubscriptions ?? await loadActiveSubscriptions(
      identity, current.operationId
    );
    const subscription = entries.find((entry) => (
      entry.operationId === current.operationId
        && entry.credentialId === identity?.credentialId
    )) ?? null;
    return {
      ...decorated,
      notification: {
        subscribed: subscription !== null,
        deliveryState: subscription?.deliveryState ?? null,
      },
    };
  }

  router.post('/session', (req, res, next) => {
    try {
      assertNoQuery(req);
      if (req.body !== undefined) throw apiError('invalid_request', 400);
      return auth.createSession(req, res, next);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.use((req, res, next) => auth.requireCredential(req, res, next));

  router.get('/notebook', asyncRoute(async (req, res) => {
    const result = await notebookService.listQueryNotebookAuthorized(listInput(req.query));
    if (!result || !Array.isArray(result.items)) throw apiError('notebook_projection_invalid', 500);
    const activeSubscriptions = await loadActiveSubscriptions(req.queryNotebookIdentity);
    res.json({
      ...result,
      items: await Promise.all(result.items.map((item) => decorateForRequest(
        validateRequester(item, requesterAgent, item.operationId),
        req.queryNotebookIdentity,
        item,
        activeSubscriptions,
      ))),
    });
  }));

  router.get('/operations/:operationId', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    const current = await status(req.params.operationId);
    res.json(await decorateForRequest(current, req.queryNotebookIdentity));
  }));

  router.get('/operations/:operationId/result', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    const current = await status(req.params.operationId);
    const result = await notebookService.getQueryNotebookResultAuthorized(req.params.operationId);
    if (!result || result.operationId !== req.params.operationId) {
      throw apiError('notebook_projection_invalid', 500);
    }
    res.json(await decorateForRequest(result, req.queryNotebookIdentity, current));
  }));

  router.post('/operations/:operationId/export', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    if (!exportConfigured) throw apiError('operation_unavailable', 503, true);
    const current = await status(req.params.operationId);
    if (current.resultAvailability === 'expired') {
      throw apiError('result_expired', 410);
    }
    if (current.resultAvailability !== 'available') {
      throw apiError('result_unavailable', 404);
    }
    const body = exactKeys(req.body, ['format']);
    if (body.format !== 'markdown') throw apiError('export_format_invalid', 400);
    const raw = await notebookService.exportQueryNotebookResultAuthorized(
      req.params.operationId, { format: body.format },
    );
    if (!raw || Array.isArray(raw) || typeof raw !== 'object'
        || Reflect.ownKeys(raw).some((key) => typeof key !== 'string'
          || ![
            'schemaVersion', 'operationId', 'resultVersion', 'format', 'filename',
            'mediaType', 'bytes', 'sha256', 'content',
          ].includes(key))
        || Reflect.ownKeys(raw).length !== 9
        || raw.schemaVersion !== 1
        || raw.operationId !== req.params.operationId
        || !RESULT_VERSION_PATTERN.test(raw.resultVersion)
        || raw.resultVersion !== current.resultVersion
        || raw.format !== 'markdown'
        || !EXPORT_FILENAME_PATTERN.test(raw.filename)
        || raw.mediaType !== 'text/markdown; charset=utf-8'
        || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0
        || raw.bytes > EXPORT_CONTENT_MAX_BYTES
        || typeof raw.content !== 'string'
        || Buffer.byteLength(raw.content, 'utf8') !== raw.bytes
        || !SHA256_PATTERN.test(raw.sha256)
        || crypto.createHash('sha256').update(raw.content, 'utf8').digest('hex') !== raw.sha256) {
      throw apiError('notebook_projection_invalid', 500);
    }
    res.setHeader('cache-control', 'no-store');
    res.json({
      schemaVersion: raw.schemaVersion,
      operationId: raw.operationId,
      resultVersion: raw.resultVersion,
      format: raw.format,
      filename: raw.filename,
      mediaType: raw.mediaType,
      bytes: raw.bytes,
      sha256: raw.sha256,
      content: raw.content,
    });
  }));

  router.post('/operations/:operationId/cancel', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    exactKeys(req.body, []);
    const before = await status(req.params.operationId);
    if (!TERMINAL_STATES.has(before.executionState)) {
      try { await coordinator.cancel(req.params.operationId); } catch (error) {
        if (error?.code !== 'operation_terminal') throw error;
      }
    }
    const current = await status(req.params.operationId);
    res.json(await decorateForRequest(current, req.queryNotebookIdentity));
  }));

  router.post('/operations/:operationId/actions', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    await status(req.params.operationId);
    const body = exactKeys(req.body, ['kind', 'actionToken', 'requestId']);
    if (!EXECUTABLE_TOKEN_ACTIONS.has(body.kind)
        || typeof body.actionToken !== 'string' || !body.actionToken
        || body.actionToken.length > 2048
        || typeof body.requestId !== 'string' || !QUERY_REQUEST_ID_PATTERN.test(body.requestId)) {
      throw apiError('invalid_request', 400);
    }
    const started = await notebookService.resolveAction({
      sourceOperationId: req.params.operationId,
      kind: body.kind,
      actionToken: body.actionToken,
      requestId: body.requestId,
    });
    validateRequester(started, requesterAgent, started.operationId);
    if (started.operationType !== 'pgs'
        || (started.state !== 'queued' && started.state !== 'running')) {
      throw apiError('notebook_projection_invalid', 500);
    }
    res.status(202).json({
      schemaVersion: 1,
      operationId: started.operationId,
      requestKind: 'pgs',
      executionState: started.state,
    });
  }));

  router.post('/operations/:operationId/notifications', asyncRoute(async (req, res) => {
    assertNoQuery(req);
    const body = exactKeys(req.body, ['enabled']);
    if (typeof body.enabled !== 'boolean') throw apiError('invalid_request', 400);
    const identity = req.queryNotebookIdentity;
    if (identity?.requesterKind !== 'device') throw apiError('access_denied', 403);
    const before = await status(req.params.operationId);
    if (!options.subscriptions
        || typeof options.subscriptions.subscribe !== 'function'
        || typeof options.subscriptions.unsubscribe !== 'function'
        || typeof options.subscriptions.markTerminalPending !== 'function') {
      throw apiError('operation_unavailable', 503, true);
    }
    if (!body.enabled) {
      await options.subscriptions.unsubscribe({
        requesterAgent, operationId: req.params.operationId,
        credentialId: identity.credentialId,
      });
      res.json({
        schemaVersion: 1, operationId: req.params.operationId, subscribed: false,
      });
      return;
    }
    const terminalState = TERMINAL_STATES.has(before.executionState)
      ? before.executionState : null;
    let subscription = await options.subscriptions.subscribe({
      requesterAgent,
      operationId: req.params.operationId,
      credentialId: identity.credentialId,
      deviceId: identity.deviceId,
      generation: identity.generation,
      expiresAt: identity.credentialExpiresAt,
      terminalState,
    });
    if (terminalState === null) {
      const after = await status(req.params.operationId);
      if (TERMINAL_STATES.has(after.executionState)) {
        const pending = await options.subscriptions.markTerminalPending({
          requesterAgent, operationId: req.params.operationId,
          terminalState: after.executionState,
        });
        subscription = pending.find((entry) => entry.credentialId === identity.credentialId)
          ?? subscription;
      }
    }
    if (subscription.deliveryState === 'pending'
        && typeof options.enqueueTerminalNotification === 'function') {
      await options.enqueueTerminalNotification(subscription);
    }
    res.json({
      schemaVersion: 1,
      operationId: req.params.operationId,
      subscribed: true,
      routeId: subscription.routeId,
      deliveryState: subscription.deliveryState,
    });
  }));

  router.get('/operations/:operationId/events', asyncRoute(async (req, res) => {
    const keys = Reflect.ownKeys(req.query || {}).sort();
    if (keys.length !== 2 || keys[0] !== 'after' || keys[1] !== 'attachmentId'
        || typeof req.query.after !== 'string'
        || !/^(?:0|[1-9]\d*)$/.test(req.query.after)
        || typeof req.query.attachmentId !== 'string') {
      throw apiError('invalid_request', 400);
    }
    const afterSequence = Number(req.query.after);
    if (!Number.isSafeInteger(afterSequence)) throw apiError('event_cursor_invalid', 400);
    let attachmentId;
    try { attachmentId = assertIdentifier(req.query.attachmentId, 'attachmentId'); } catch (error) {
      throw apiError('invalid_request', 400, false, error);
    }
    const currentStatus = await status(req.params.operationId);
    const current = await decorateForRequest(
      currentStatus, req.queryNotebookIdentity, currentStatus,
    );
    const controller = new AbortController();
    const close = () => controller.abort(apiError('attachment_closed', 499));
    res.once('close', close);
    let attachment;
    try {
      attachment = await coordinator.attach(req.params.operationId, {
        attachmentId,
        afterSequence,
        signal: controller.signal,
        onEvent: undefined,
      });
      if (!attachment || typeof attachment.nextEvent !== 'function') {
        throw apiError('event_stream_invalid', 500);
      }
      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();
      const snapshotSequence = Number.isSafeInteger(current.progress?.eventSequence)
        ? current.progress.eventSequence : afterSequence;
      const snapshot = {
        type: 'snapshot', operationId: current.operationId,
        eventSequence: snapshotSequence,
        executionState: current.executionState,
        progress: current.progress,
        error: current.error,
        resultAvailability: current.resultAvailability,
        resultVersion: current.resultVersion,
        actions: current.actions,
        notification: current.notification,
      };
      if (!await writeNotebookSseFrame(
        res, sseFrame('snapshot', snapshotSequence, snapshot), controller.signal,
      )) return;
      while (!controller.signal.aborted) {
        const event = await nextEventUntilAbort(attachment, controller.signal);
        if (event === null) break;
        const projected = projectStreamEvent(req.params.operationId, event);
        if (!projected) continue;
        if (!await writeNotebookSseFrame(
          res, sseFrame(projected.type, projected.sequence, projected.value), controller.signal,
        )) break;
        if (projected.type === 'terminal') break;
      }
      if (!res.writableEnded) res.end();
    } finally {
      res.off?.('close', close);
      controller.abort(apiError('attachment_closed', 499));
      if (attachment) {
        await coordinator.detach(req.params.operationId, {
          attachmentId, reason: 'client_closed',
        }).catch(() => {});
      }
    }
  }));

  return router;
}

module.exports = {
  ACTION_ORDER,
  createHome23QueryNotebookRouter,
  createQueryNotebookPlaceholderRouter,
  decorateActions,
  writeNotebookSseFrame,
};
