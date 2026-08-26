const express = require('express');

const DEFAULT_ORIGIN = 'http://127.0.0.1:7346';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const ROUTES = [
  { method: 'GET', path: /^\/capabilities$/ },
  { method: 'GET', path: /^\/bootstrap$/ },
  { method: 'GET', path: /^\/bots(?:\/[^/]+)?$/ },
  { method: 'POST', path: /^\/bots$/ },
  { method: 'POST', path: /^\/bots\/[^/]+\/(?:start|stop|restart|archive|restore)$/ },
  { method: 'GET', path: /^\/(?:inbox|conversations|unread|activity|search)$/ },
  { method: 'GET', path: /^\/channels(?:\/[^/]+)?$/ },
  { method: 'POST', path: /^\/channels$/ },
  { method: 'GET', path: /^\/channels\/[^/]+\/messages$/ },
  { method: 'POST', path: /^\/channels\/[^/]+\/(?:messages|read|coordinate)$/ },
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
  const router = express.Router();

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
    for (const name of ['idempotency-key', 'x-correlation-id']) {
      const value = req.get(name);
      if (value) headers[name] = value;
    }
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body ?? {});
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
    timeout.unref?.();
    try {
      const upstream = await fetchImpl(`${origin}/api/v1${productPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`, {
        method: req.method, headers, body, signal: controller.signal, redirect: 'manual',
      });
      const length = Number(upstream.headers.get('content-length') || 0);
      if (length > MAX_RESPONSE_BYTES) throw new Error('coordination_proxy_response_too_large');
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('coordination_proxy_response_too_large');
      res.status(upstream.status);
      for (const name of ['content-type', 'x-request-id', 'x-correlation-id']) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }
      res.set('Cache-Control', 'no-store');
      return res.send(bytes);
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'coordination_timeout' : 'coordination_unavailable';
      return res.status(503).json({ error: { code, message: 'Connected Agents is unavailable.', retryable: true } });
    } finally {
      clearTimeout(timeout);
    }
  });
  return router;
}

module.exports = { allowed, coordinationOrigin, createConnectedAgentsProxy };
