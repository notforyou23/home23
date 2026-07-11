'use strict';

function runtimeMetricError(code) {
  return Object.assign(new Error(code), { code });
}

function isLoopback(address) {
  return typeof address === 'string' && (
    address === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(address)
    || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address)
  );
}

function createRuntimeMetricsHandler({
  role,
  pid = () => process.pid,
  memoryUsage = () => process.memoryUsage(),
  resourceUsage = () => process.resourceUsage(),
  now = () => Date.now(),
} = {}) {
  if (typeof role !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(role)
      || typeof pid !== 'function' || typeof memoryUsage !== 'function'
      || typeof resourceUsage !== 'function' || typeof now !== 'function') {
    throw runtimeMetricError('runtime_metrics_configuration_invalid');
  }
  return function runtimeMetrics(req, res) {
    if (req?.method !== 'GET') {
      res.status(405).json({ error: { code: 'method_not_allowed' } });
      return;
    }
    if (!isLoopback(req?.socket?.remoteAddress)) {
      res.status(403).json({ error: { code: 'access_denied' } });
      return;
    }
    const processId = Number(pid());
    const memory = memoryUsage();
    const v8HeapUsedBytes = Number(memory?.heapUsed);
    const rssBytes = Number(memory?.rss);
    const maxRssKiB = Number(resourceUsage()?.maxRSS);
    const processMaxRssBytes = maxRssKiB * 1024;
    const sampledAtMs = Number(now());
    if (!Number.isSafeInteger(processId) || processId < 1
        || !Number.isSafeInteger(v8HeapUsedBytes) || v8HeapUsedBytes < 0
        || !Number.isSafeInteger(rssBytes) || rssBytes < 0
        || !Number.isSafeInteger(maxRssKiB) || maxRssKiB < 0
        || !Number.isSafeInteger(processMaxRssBytes) || processMaxRssBytes < rssBytes
        || !Number.isFinite(sampledAtMs)) {
      res.status(503).json({ error: { code: 'runtime_metrics_unavailable' } });
      return;
    }
    res.set?.('cache-control', 'no-store');
    res.status(200).json({
      schemaVersion: 2,
      role,
      pid: processId,
      v8HeapUsedBytes,
      rssBytes,
      processMaxRssBytes,
      semantics: {
        v8HeapUsedBytes: 'request-time-sample',
        rssBytes: 'request-time-sample',
        processMaxRssBytes: 'process-lifetime-high-water',
      },
      sampledAt: new Date(sampledAtMs).toISOString(),
    });
  };
}

function registerRuntimeMetricsRoute(app, { route, ...options } = {}) {
  if (!app || typeof app.get !== 'function'
      || typeof route !== 'string' || !route.startsWith('/') || route.includes('\0')) {
    throw runtimeMetricError('runtime_metrics_configuration_invalid');
  }
  const handler = createRuntimeMetricsHandler(options);
  app.get(route, handler);
  return handler;
}

module.exports = {
  createRuntimeMetricsHandler,
  isLoopback,
  registerRuntimeMetricsRoute,
};
