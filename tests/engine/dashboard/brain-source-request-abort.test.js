import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setImmediate as immediate } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  requestAbortController: dashboardRequestAbortController,
} = require('../../../engine/src/dashboard/brain-source-api.js');
const {
  requestAbortController: cosmoRequestAbortController,
} = require('../../../cosmo23/server/lib/brain-source-router.js');

const implementations = [
  ['dashboard', dashboardRequestAbortController],
  ['COSMO', cosmoRequestAbortController],
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function withDeadline(promise, label, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startApp(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

for (const [label, makeController] of implementations) {
  test(`${label} request cancellation ignores a normal completed POST request close`, async () => {
    const app = express();
    app.use(express.json());
    const observed = deferred();

    app.post('/probe', async (req, res) => {
      const requestClosed = deferred();
      req.once('close', () => requestClosed.resolve());
      const controller = makeController(req, res);
      const completeAtAttach = req.complete;
      await requestClosed.promise;
      await immediate();
      const value = {
        completeAtAttach,
        completeAfterClose: req.complete,
        requestAborted: req.aborted,
        signalAborted: controller.signal.aborted,
      };
      observed.resolve(value);
      return res.status(controller.signal.aborted ? 499 : 200).json(value);
    });

    const server = await startApp(app);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'normal completed body' }),
      });
      const value = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(value, {
        completeAtAttach: true,
        completeAfterClose: true,
        requestAborted: false,
        signalAborted: false,
      });
      assert.deepEqual(await observed.promise, value);
    } finally {
      await server.close();
    }
  });

  test(`${label} request cancellation aborts a genuinely incomplete client request`, async () => {
    const app = express();
    const started = deferred();
    const observed = deferred();

    app.post('/probe', (req, res) => {
      const controller = makeController(req, res);
      const report = () => observed.resolve({
        requestComplete: req.complete,
        requestAborted: req.aborted,
        signalAborted: controller.signal.aborted,
        code: controller.signal.reason?.code,
      });
      if (controller.signal.aborted) report();
      else controller.signal.addEventListener('abort', report, { once: true });
      started.resolve();
    });

    const server = await startApp(app);
    let socket;
    try {
      socket = net.createConnection({ host: '127.0.0.1', port: server.port });
      socket.on('error', () => {});
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write([
        'POST /probe HTTP/1.1',
        `Host: 127.0.0.1:${server.port}`,
        'Content-Type: application/json',
        'Content-Length: 64',
        'Connection: close',
        '',
        '{"query":"partial',
      ].join('\r\n'));
      await withDeadline(started.promise, `${label} incomplete request start`);
      socket.destroy();
      assert.deepEqual(
        await withDeadline(observed.promise, `${label} incomplete request abort`),
        {
          requestComplete: false,
          requestAborted: true,
          signalAborted: true,
          code: 'cancelled',
        },
      );
    } finally {
      socket?.destroy();
      await server.close();
    }
  });

  test(`${label} request cancellation aborts a premature response close after request completion`, async () => {
    const app = express();
    const started = deferred();
    const observed = deferred();

    app.post('/probe', (req, res) => {
      req.once('close', () => {
        const controller = makeController(req, res);
        const report = () => observed.resolve({
          requestComplete: req.complete,
          requestAborted: req.aborted,
          responseEnded: res.writableEnded,
          signalAborted: controller.signal.aborted,
          code: controller.signal.reason?.code,
        });
        if (controller.signal.aborted) report();
        else controller.signal.addEventListener('abort', report, { once: true });
        started.resolve();
      });
      req.resume();
    });

    const server = await startApp(app);
    let request;
    try {
      request = http.request({
        host: '127.0.0.1',
        port: server.port,
        path: '/probe',
        method: 'POST',
        headers: { 'content-length': '0' },
      });
      request.on('error', () => {});
      request.end();
      await withDeadline(started.promise, `${label} completed request close`);
      request.destroy();
      assert.deepEqual(
        await withDeadline(observed.promise, `${label} premature response close`),
        {
          requestComplete: true,
          requestAborted: false,
          responseEnded: false,
          signalAborted: true,
          code: 'cancelled',
        },
      );
    } finally {
      request?.destroy();
      await server.close();
    }
  });

  test(`${label} request cancellation observes a response that closed before listener attachment`, async () => {
    const app = express();
    const requestComplete = deferred();
    const observed = deferred();

    app.post('/probe', (req, res) => {
      req.once('close', () => {
        res.once('close', () => {
          const controller = makeController(req, res);
          observed.resolve({
            requestComplete: req.complete,
            requestAborted: req.aborted,
            responseDestroyed: res.destroyed,
            responseEnded: res.writableEnded,
            signalAborted: controller.signal.aborted,
            code: controller.signal.reason?.code,
          });
        });
        requestComplete.resolve();
      });
      req.resume();
    });

    const server = await startApp(app);
    let request;
    try {
      request = http.request({
        host: '127.0.0.1',
        port: server.port,
        path: '/probe',
        method: 'POST',
        headers: { 'content-length': '0' },
      });
      request.on('error', () => {});
      request.end();
      await withDeadline(requestComplete.promise, `${label} late attachment request close`);
      request.destroy();
      assert.deepEqual(
        await withDeadline(observed.promise, `${label} late response-close observation`),
        {
          requestComplete: true,
          requestAborted: false,
          responseDestroyed: true,
          responseEnded: false,
          signalAborted: true,
          code: 'cancelled',
        },
      );
    } finally {
      request?.destroy();
      await server.close();
    }
  });
}
