'use strict';

const express = require('express');
const http = require('node:http');

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function proxyError(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function copyResponseHeaders(upstream, response) {
  for (const name of ['content-type', 'cache-control', 'mcp-session-id']) {
    const value = upstream.headers[name];
    if (value !== undefined) response.setHeader(name, value);
  }
}

function sendProxyError(res, status, code, message, port) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.status(status).json({
    ok: false,
    error: { code, message },
    mcpPort: port,
  });
}

function createMcpProxyRouter({
  port,
  isEnabled,
  probeAvailability,
  buildUnavailableEnvelope,
  httpImpl = http,
  requestBodyLimit = '16mb',
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  logger = console,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535
      || typeof isEnabled !== 'function'
      || typeof probeAvailability !== 'function'
      || typeof buildUnavailableEnvelope !== 'function'
      || !httpImpl || typeof httpImpl.request !== 'function'
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw proxyError('mcp_proxy_configuration_invalid');
  }
  const router = express.Router();
  const parseJson = express.json({ limit: requestBodyLimit, strict: true });

  router.post('/api/mcp', parseJson, async (req, res) => {
    let upstreamRequest = null;
    let upstreamResponse = null;
    let complete = false;
    const disconnect = () => {
      if (complete) return;
      const reason = proxyError('cancelled', 'MCP proxy client disconnected');
      upstreamResponse?.destroy(reason);
      upstreamRequest?.destroy(reason);
    };
    const requestClosed = () => {
      if (req.aborted || req.complete !== true) disconnect();
    };
    req.once('aborted', disconnect);
    req.once('close', requestClosed);
    res.once('close', disconnect);
    try {
      const availability = await probeAvailability({
        enabled: isEnabled(),
        port,
      });
      if (!availability.available) {
        complete = true;
        return res.status(503).json(buildUnavailableEnvelope(port, availability));
      }
      const postData = JSON.stringify(req.body);
      await new Promise((resolve, reject) => {
        upstreamRequest = httpImpl.request({
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: req.headers.accept || 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(postData),
          },
        }, (mcpRes) => {
          upstreamResponse = mcpRes;
          res.status(mcpRes.statusCode || 502);
          copyResponseHeaders(mcpRes, res);
          let receivedBytes = 0;
          let responseFailed = false;
          mcpRes.on('data', (chunk) => {
            if (responseFailed) return;
            receivedBytes += chunk.length;
            if (receivedBytes > maxResponseBytes) {
              responseFailed = true;
              reject(proxyError('mcp_response_too_large', 'MCP response exceeds proxy limit', {
                status: 502,
              }));
              mcpRes.destroy();
              upstreamRequest.destroy();
              return;
            }
            if (!res.write(chunk)) {
              mcpRes.pause();
              res.once('drain', () => mcpRes.resume());
            }
          });
          mcpRes.once('end', () => {
            if (responseFailed) return;
            if (!res.writableEnded) res.end();
            resolve();
          });
          mcpRes.once('error', reject);
        });
        upstreamRequest.once('error', reject);
        upstreamRequest.setTimeout?.(0);
        upstreamRequest.end(postData);
      });
      complete = true;
    } catch (error) {
      if (error?.code !== 'cancelled') {
        logger.error?.('[MCP Proxy] Request failed:', error);
      }
      if (error?.code === 'mcp_response_too_large' && res.headersSent) {
        res.destroy(error);
      } else {
        sendProxyError(
          res,
          error?.status || (error?.code === 'cancelled' ? 499 : 502),
          error?.code || 'mcp_proxy_failed',
          error?.message || 'MCP proxy failed',
          port,
        );
      }
    } finally {
      complete = true;
      req.off('aborted', disconnect);
      req.off('close', requestClosed);
      res.off('close', disconnect);
    }
  });

  router.use((error, _req, res, next) => {
    if (error?.type !== 'entity.too.large') return next(error);
    return sendProxyError(res, 413, 'request_too_large', 'MCP proxy request exceeds limit', port);
  });
  return router;
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  createMcpProxyRouter,
};
