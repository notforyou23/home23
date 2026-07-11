'use strict';

const express = require('express');

function routeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bearerCapability(req) {
  const header = typeof req.get === 'function'
    ? req.get('authorization')
    : req.headers?.authorization;
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
  if (!match) throw routeError('capability_invalid');
  return match[1];
}

function assertLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress;
  const loopback = typeof address === 'string'
    && (address === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(address)
      || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address));
  if (!loopback) throw routeError('access_denied');
}

function parseAfterSequence(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw routeError('worker_event_cursor_invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw routeError('worker_event_cursor_invalid');
  }
  return parsed;
}

function errorStatus(error) {
  if (Number.isSafeInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600) {
    return error.statusCode;
  }
  const code = error?.code;
  if (code === 'request_too_large') return 413;
  if (['capability_invalid', 'capability_expired', 'capability_replay',
    'capability_nonce_capacity'].includes(code)) return 401;
  if (['capability_mismatch', 'access_denied'].includes(code)) return 403;
  if (['worker_not_found', 'target_not_found'].includes(code)) return 404;
  if (['worker_operation_conflict', 'worker_result_unavailable'].includes(code)) return 409;
  if (code === 'operation_timeout') return 504;
  if (['executor_unavailable', 'source_unavailable'].includes(code)) return 503;
  if (['invalid_request', 'operation_id_invalid', 'source_pin_invalid',
    'worker_event_cursor_invalid'].includes(code)) return 400;
  return 500;
}

function boundedJson(limit) {
  const parser = express.json({ limit, strict: true });
  return (req, res, next) => parser(req, res, (error) => {
    if (!error) return next();
    return sendError(res, routeError(
      error.type === 'entity.too.large' ? 'request_too_large' : 'invalid_request',
    ));
  });
}

function sendError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal_error';
  const message = code === 'internal_error' ? 'internal error' : String(error?.message || code).slice(0, 4096);
  if (res.headersSent) {
    res.end(`${JSON.stringify({ error: { code, message } })}\n`);
    return;
  }
  res.status(errorStatus(error)).json({
    success: false,
    error: { code, message },
  });
}

function assertEmptyBody(body) {
  if (body === undefined || body === null) return;
  if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).length !== 0) throw routeError('invalid_request');
}

function waitForDrain(res, signal) {
  if (signal.aborted) return Promise.resolve();
  if (typeof res.once !== 'function') {
    return Promise.reject(routeError('worker_event_backpressure_unavailable'));
  }
  return new Promise((resolve) => {
    const settled = () => {
      res.off?.('drain', settled);
      signal.removeEventListener('abort', settled);
      resolve();
    };
    res.once('drain', settled);
    signal.addEventListener('abort', settled, { once: true });
  });
}

function createBrainOperationRouteHandlers({ worker } = {}) {
  if (!worker || typeof worker !== 'object') throw routeError('worker_configuration_invalid');
  for (const method of ['start', 'status', 'events', 'result', 'cancel']) {
    if (typeof worker[method] !== 'function') throw routeError('worker_configuration_invalid');
  }
  return Object.freeze({
    async start(req, res) {
      try {
        assertLoopbackRequest(req);
        const capability = bearerCapability(req);
        const result = await worker.start(req.params.id, capability, req.body);
        res.json(result);
      } catch (error) {
        sendError(res, error);
      }
    },

    async status(req, res) {
      try {
        assertLoopbackRequest(req);
        const capability = bearerCapability(req);
        const result = await worker.status(req.params.id, capability);
        res.json(result);
      } catch (error) {
        sendError(res, error);
      }
    },

    async events(req, res) {
      const controller = new AbortController();
      const abort = () => {
        if (!controller.signal.aborted) controller.abort(routeError('worker_event_disconnected'));
      };
      req.on?.('aborted', abort);
      res.on?.('close', abort);
      if (req.aborted === true || res.destroyed === true || res.closed === true) abort();
      try {
        assertLoopbackRequest(req);
        const capability = bearerCapability(req);
        const afterSequence = parseAfterSequence(req.query?.afterSequence);
        res.set('content-type', 'application/x-ndjson; charset=utf-8');
        res.set('cache-control', 'no-store');
        for await (const event of worker.events(req.params.id, capability, {
          afterSequence,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          if (!res.write(`${JSON.stringify(event)}\n`)) {
            await waitForDrain(res, controller.signal);
          }
        }
        if (!res.ended) res.end();
      } catch (error) {
        sendError(res, error);
      } finally {
        req.off?.('aborted', abort);
        res.off?.('close', abort);
      }
    },

    async result(req, res) {
      try {
        assertLoopbackRequest(req);
        const capability = bearerCapability(req);
        const result = await worker.result(req.params.id, capability);
        res.json(result);
      } catch (error) {
        sendError(res, error);
      }
    },

    async cancel(req, res) {
      try {
        assertLoopbackRequest(req);
        assertEmptyBody(req.body);
        const capability = bearerCapability(req);
        const result = await worker.cancel(req.params.id, capability);
        res.json(result);
      } catch (error) {
        sendError(res, error);
      }
    },
  });
}

function createBrainOperationRoutes(options) {
  const handlers = createBrainOperationRouteHandlers(options);
  const router = express.Router();
  router.post(
    '/api/internal/brain-operations/:id/start',
    boundedJson('2mb'),
    handlers.start,
  );
  router.get('/api/internal/brain-operations/:id/status', handlers.status);
  router.get('/api/internal/brain-operations/:id/events', handlers.events);
  router.get('/api/internal/brain-operations/:id/result', handlers.result);
  router.post(
    '/api/internal/brain-operations/:id/cancel',
    boundedJson('256kb'),
    handlers.cancel,
  );
  return router;
}

module.exports = {
  assertLoopbackRequest,
  bearerCapability,
  boundedJson,
  createBrainOperationRouteHandlers,
  createBrainOperationRoutes,
  errorStatus,
  parseAfterSequence,
};
