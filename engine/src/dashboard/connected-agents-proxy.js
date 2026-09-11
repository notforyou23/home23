const express = require('express');

const DEFAULT_ORIGIN = 'http://127.0.0.1:7346';
// Communication pages can contain exact provider/runtime payloads. Keep the
// dashboard hop bounded, but large enough for a deliberately small evidence
// page without truncating or rewriting any event.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 + 64 * 1024;

const ROUTES = [
  { method: 'GET', path: /^\/capabilities$/ },
  { method: 'GET', path: /^\/bootstrap$/ },
  { method: 'GET', path: /^\/bots(?:\/[^/]+)?$/ },
  { method: 'POST', path: /^\/bots$/ },
  { method: 'POST', path: /^\/bots\/[^/]+\/(?:archive|restore)$/ },
  { method: 'GET', path: /^\/(?:inbox|conversations|unread|activity|search)$/ },
  { method: 'GET', path: /^\/communications\/events$/ },
  { method: 'GET', path: /^\/channels(?:\/[^/]+)?$/ },
  { method: 'POST', path: /^\/channels$/ },
  { method: 'GET', path: /^\/channels\/[^/]+\/messages$/ },
  { method: 'GET', path: /^\/channels\/[^/]+\/execution-options$/ },
  { method: 'POST', path: /^\/channels\/[^/]+\/(?:messages|read|coordinate)$/ },
  { method: 'GET', path: /^\/work\/[^/]+$/ },
  { method: 'POST', path: /^\/work\/[^/]+\/(?:cancel|retry)$/ },
  { method: 'POST', path: /^\/attachments$/ },
  { method: 'GET', path: /^\/attachments\/[^/]+(?:\/content)?$/ },
  { method: 'DELETE', path: /^\/attachments\/[^/]+$/ },
];

function coordinationOrigin(value = process.env.HOME23_COORDINATION_ORIGIN || DEFAULT_ORIGIN) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('coordination_proxy_origin_invalid'); }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || !['127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new TypeError('coordination_proxy_origin_invalid');
  }
  return parsed.origin;
}

function allowed(method, productPath) {
  return ROUTES.some((route) => route.method === method && route.path.test(productPath));
}

function validBearer(value) {
  return typeof value === 'string' && /^Bearer [^\s,]{1,4096}$/.test(value);
}

function createConnectedAgentsProxy(options = {}) {
  const origin = coordinationOrigin(options.origin);
  const fetchImpl = options.fetchImpl || fetch;
  const maxResponseBytes = options.maxResponseBytes || MAX_RESPONSE_BYTES;
  const router = express.Router();

  // Product mutations are small structured commands. Parse them here so this
  // surface never falls through to the dashboard's legacy 10GB body parser.
  router.use(express.json({ limit: options.maxRequestBytes || '32kb' }));

  router.use(async (req, res) => {
    const productPath = req.path;
    if (!allowed(req.method, productPath)) {
      return res.status(404).json({ error: { code: 'route_not_found', message: 'Product route is not available through the dashboard.' } });
    }
    const authorization = req.get('authorization');
    if (productPath !== '/capabilities' && !validBearer(authorization)) {
      return res.status(401).json({ error: { code: 'access_invalid', message: 'A valid product API bearer token is required.' } });
    }
    const headers = { accept: 'application/json' };
    if (authorization) headers.authorization = authorization;
    for (const name of ['idempotency-key', 'x-correlation-id', 'range']) {
      const value = req.get(name);
      if (value) headers[name] = value;
    }
    let body;
    let uploadTooLarge = false;
    const upload = req.method === 'POST' && productPath === '/attachments';
    if (upload) {
      const type = req.get('content-type') || '';
      if (!/^multipart\/form-data;\s*boundary=/i.test(type)) {
        return res.status(415).json({ error: { code: 'invalid_content_type', message: 'Use multipart form data for attachments.' } });
      }
      if (Number(req.get('content-length') || 0) > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: { code: 'size_limit_exceeded', message: 'Attachments can be up to 25 MB.' } });
      }
      headers['content-type'] = type;
      body = (async function* () {
        let count = 0;
        for await (const chunk of req) {
          count += chunk.length;
          if (count > MAX_UPLOAD_BYTES) { uploadTooLarge = true; throw new Error('coordination_proxy_upload_too_large'); }
          yield chunk;
        }
      })();
    } else if (!['GET', 'HEAD'].includes(req.method)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body ?? {});
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || (upload ? 120_000 : 15_000));
    const abort = () => controller.abort();
    req.once('aborted', abort);
    timeout.unref?.();
    try {
      const upstream = await fetchImpl(`${origin}/api/v1${productPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`, {
        method: req.method, headers, body, signal: controller.signal, redirect: 'manual',
        ...(upload ? { duplex: 'half' } : {}),
      });
      const length = Number(upstream.headers.get('content-length') || 0);
      if (length > maxResponseBytes) { controller.abort(); throw new Error('coordination_proxy_response_too_large'); }
      const chunks = [];
      let byteCount = 0;
      for await (const chunk of upstream.body || []) {
        byteCount += chunk.length;
        if (byteCount > maxResponseBytes) {
          controller.abort();
          throw new Error('coordination_proxy_response_too_large');
        }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, byteCount);
      res.status(upstream.status);
      for (const name of ['content-type', 'x-request-id', 'x-correlation-id', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'x-content-type-options', 'content-security-policy']) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }
      res.set('Cache-Control', 'no-store');
      return res.send(bytes);
    } catch (error) {
      if (uploadTooLarge) return res.status(413).json({ error: { code: 'size_limit_exceeded', message: 'Attachments can be up to 25 MB.', retryable: false } });
      const oversized = error?.message === 'coordination_proxy_response_too_large';
      const code = oversized
        ? 'coordination_response_too_large'
        : error?.name === 'AbortError'
          ? 'coordination_timeout'
          : 'coordination_unavailable';
      const message = oversized
        ? 'The exact response exceeded this dashboard safety boundary. Request a smaller evidence page.'
        : 'Connected Agents is unavailable.';
      return res.status(503).json({ error: { code, message, retryable: !oversized } });
    } finally {
      req.removeListener('aborted', abort);
      clearTimeout(timeout);
    }
  });
  return router;
}

module.exports = { allowed, coordinationOrigin, createConnectedAgentsProxy };
