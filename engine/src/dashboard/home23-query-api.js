const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_ENDPOINTS = {
  catalog: '/home23/api/query/catalog',
  run: '/home23/api/query/run',
  stream: '/home23/api/query/stream',
  export: '/home23/api/query/export',
};

function getDefaultCosmoBaseUrl() {
  return `http://localhost:${process.env.COSMO23_PORT || '43210'}`;
}

function readYaml(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
}

function discoverAgents(home23Root) {
  const instancesDir = path.join(home23Root, 'instances');
  if (!fs.existsSync(instancesDir)) return [];
  return fs.readdirSync(instancesDir).filter((name) => {
    const dir = path.join(instancesDir, name);
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'config.yaml'));
  });
}

function resolveAgentFromRoot(home23Root, candidate, fallback = 'jerry') {
  const requested = String(candidate || '').replace(/^home23-/, '').trim();
  const agents = discoverAgents(home23Root);
  if (requested && agents.includes(requested)) return requested;
  if (fallback && agents.includes(fallback)) return fallback;
  return agents[0] || requested || fallback || null;
}

function loadQueryDefaults(home23Root, agent) {
  if (!home23Root) {
    return {
      defaultModel: '',
      defaultMode: 'full',
      enablePGSByDefault: false,
      pgsSweepModel: '',
      pgsSynthModel: '',
      pgsDepth: 0.25,
    };
  }
  const homeConfig = readYaml(path.join(home23Root, 'config', 'home.yaml'));
  const agentConfig = agent ? readYaml(path.join(home23Root, 'instances', agent, 'config.yaml')) : {};
  const q = agentConfig.query || homeConfig.query || {};
  const agentChat = agentConfig.chat || homeConfig.chat || {};
  return {
    defaultModel: q.defaultModel || '',
    defaultProvider: q.defaultProvider || q.provider || agentChat.defaultProvider || agentChat.provider || '',
    defaultMode: q.defaultMode || 'full',
    enablePGSByDefault: !!q.enablePGSByDefault,
    pgsSweepModel: q.pgsSweepModel || '',
    pgsSweepProvider: q.pgsSweepProvider || '',
    pgsSynthModel: q.pgsSynthModel || '',
    pgsSynthProvider: q.pgsSynthProvider || q.defaultProvider || q.provider || agentChat.defaultProvider || agentChat.provider || '',
    pgsDepth: typeof q.pgsDepth === 'number' ? q.pgsDepth : 0.25,
  };
}

async function fetchJson(fetchImpl, baseUrl, route, timeoutMs) {
  const url = `${String(baseUrl).replace(/\/$/, '')}${route}`;
  const init = {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const message = body?.error || body?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function normalizeModels(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.models || []);
  return raw
    .filter((model) => model && model.kind !== 'embedding')
    .map((model) => ({
      id: String(model.id || model.model || ''),
      name: model.name || model.label || model.id || null,
      provider: model.provider || null,
      providerLabel: model.providerLabel || null,
      kind: model.kind || null,
      source: model.source || null,
    }))
    .filter((model) => model.id);
}

function normalizeBrains(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.brains || []);
  return raw
    .filter(Boolean)
    .map((brain) => ({
      id: brain.id || null,
      routeKey: brain.routeKey || brain.id || null,
      name: brain.name || null,
      displayName: brain.displayName || brain.name || brain.id || null,
      path: brain.path || null,
      sourceLabel: brain.sourceLabel || null,
      sourceType: brain.sourceType || null,
      isReference: brain.isReference ?? null,
      isActive: brain.isActive ?? null,
      modifiedDate: brain.modifiedDate || null,
      topic: brain.topic || brain.domain || null,
    }));
}

function findSelectedBrain(brains, agent) {
  const target = String(agent || '').toLowerCase();
  if (!target) return null;
  return brains.find((brain) => {
    const source = String(brain.sourceLabel || '').toLowerCase();
    const display = String(brain.displayName || '').toLowerCase();
    const p = String(brain.path || '').toLowerCase();
    return source === target
      || display === `${target} brain`
      || p.endsWith(`/instances/${target}/brain`);
  }) || null;
}

function normalizeCosmoStatus(payload, error) {
  if (error) {
    return {
      apiReachable: false,
      running: false,
      activeRun: false,
      lifecycle: 'unreachable',
      processOnline: false,
      activeContext: null,
    };
  }
  const health = payload?.health || {};
  return {
    apiReachable: payload?.apiReachable ?? health.apiReachable ?? true,
    running: payload?.running ?? health.running ?? false,
    activeRun: payload?.activeRun ?? health.activeRun ?? false,
    lifecycle: payload?.lifecycle ?? health.lifecycle ?? null,
    processOnline: payload?.processOnline ?? health.processOnline ?? null,
    activeContext: payload?.activeContext ?? health.run ?? null,
  };
}

function availabilityFor({ statusError, models, brains, selectedBrain }) {
  if (statusError) return 'cosmo23 unreachable';
  if (!models.length) return 'no query models available';
  if (!brains.length) return 'no brains available';
  if (!selectedBrain) return 'selected agent brain unavailable';
  return null;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'dry-run', 'validate-only'].includes(value.toLowerCase());
}

function isDryRunRequest(req) {
  const body = req.body || {};
  const query = req.query || {};
  return truthyFlag(body.dryRun)
    || truthyFlag(body.dry_run)
    || truthyFlag(body.validateOnly)
    || truthyFlag(body.validate_only)
    || truthyFlag(query.dryRun)
    || truthyFlag(query.dry_run)
    || truthyFlag(query.validateOnly)
    || truthyFlag(query.validate_only);
}

function buildDryRunQueryResult(req, { agent, catalog, operation }) {
  const body = req.body || {};
  const model = body.model || catalog?.defaults?.model || catalog?.models?.[0]?.id || null;
  const mode = body.mode || catalog?.defaults?.mode || 'quick';
  const selectedBrain = catalog?.selectedBrain
    ? {
      id: catalog.selectedBrain.id || null,
      routeKey: catalog.selectedBrain.routeKey || null,
      displayName: catalog.selectedBrain.displayName || null,
    }
    : null;

  return {
    query: String(body.query || '').trim() || 'contract validation dry run',
    answer: `Dry run accepted: ${operation} facade request validated without forwarding to COSMO23.`,
    metadata: {
      dryRun: true,
      operation,
      agent,
      model,
      mode,
      timestamp: new Date().toISOString(),
      catalogAvailable: catalog?.available === true,
      selectedBrain,
    },
  };
}

async function buildQueryCatalog(options = {}) {
  const home23Root = options.home23Root || null;
  const fallbackAgent = options.getDefaultAgent?.() || process.env.HOME23_AGENT || 'jerry';
  const agent = options.agent || (home23Root ? resolveAgentFromRoot(home23Root, null, fallbackAgent) : fallbackAgent);
  const cosmoBaseUrl = options.cosmoBaseUrl || getDefaultCosmoBaseUrl();
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 5000);
  const queryDefaults = options.queryDefaultsProvider
    ? options.queryDefaultsProvider(agent)
    : loadQueryDefaults(home23Root, agent);

  const [statusResult, modelsResult, brainsResult] = await Promise.allSettled([
    fetchJson(fetchImpl, cosmoBaseUrl, '/api/status', timeoutMs),
    fetchJson(fetchImpl, cosmoBaseUrl, '/api/providers/models', timeoutMs),
    fetchJson(fetchImpl, cosmoBaseUrl, '/api/brains', timeoutMs),
  ]);

  const statusError = statusResult.status === 'rejected' ? statusResult.reason : null;
  const modelError = modelsResult.status === 'rejected' ? modelsResult.reason : null;
  const brainError = brainsResult.status === 'rejected' ? brainsResult.reason : null;
  const models = modelsResult.status === 'fulfilled' ? normalizeModels(modelsResult.value) : [];
  const brains = brainsResult.status === 'fulfilled' ? normalizeBrains(brainsResult.value) : [];
  const selectedBrain = findSelectedBrain(brains, agent);
  const reason = availabilityFor({ statusError, models, brains, selectedBrain });
  const firstError = statusError || modelError || brainError;

  return {
    agent,
    available: reason === null,
    reason,
    endpoints: {
      run: DEFAULT_ENDPOINTS.run,
      stream: DEFAULT_ENDPOINTS.stream,
      export: DEFAULT_ENDPOINTS.export,
    },
    models,
    defaults: {
      model: queryDefaults.defaultModel || models[0]?.id || null,
      provider: queryDefaults.defaultProvider || null,
      mode: queryDefaults.defaultMode || 'full',
      enablePGSByDefault: !!queryDefaults.enablePGSByDefault,
      pgsSweepModel: queryDefaults.pgsSweepModel || null,
      pgsSweepProvider: queryDefaults.pgsSweepProvider || null,
      pgsSynthModel: queryDefaults.pgsSynthModel || null,
      pgsSynthProvider: queryDefaults.pgsSynthProvider || queryDefaults.defaultProvider || null,
      pgsDepth: typeof queryDefaults.pgsDepth === 'number' ? queryDefaults.pgsDepth : 0.25,
    },
    brains,
    selectedBrain,
    cosmo: normalizeCosmoStatus(statusResult.status === 'fulfilled' ? statusResult.value : null, statusError),
    streaming: false,
    limits: {
      maxQueryChars: 12000,
      maxPriorContextChars: 20000,
    },
    lastRouteError: firstError ? (firstError.message || String(firstError)) : null,
  };
}

function createQueryApiRouter(options = {}) {
  const router = express.Router();
  const resolveAgent = options.resolveAgent || ((candidate) => {
    if (options.home23Root) {
      return resolveAgentFromRoot(options.home23Root, candidate, options.getDefaultAgent?.() || 'jerry');
    }
    return candidate || options.getDefaultAgent?.() || 'jerry';
  });

  router.get('/catalog', async (req, res) => {
    try {
      const agent = resolveAgent(req.query?.agent);
      const catalog = await buildQueryCatalog({ ...options, agent });
      res.json(catalog);
    } catch (err) {
      res.status(500).json({
        agent: req.query?.agent || options.getDefaultAgent?.() || null,
        available: false,
        reason: 'query catalog error',
        endpoints: { run: DEFAULT_ENDPOINTS.run, stream: DEFAULT_ENDPOINTS.stream, export: DEFAULT_ENDPOINTS.export },
        models: [],
        defaults: null,
        brains: [],
        selectedBrain: null,
        cosmo: normalizeCosmoStatus(null, err),
        streaming: false,
        limits: { maxQueryChars: 12000 },
        lastRouteError: err.message || String(err),
      });
    }
  });

  router.post('/run', async (req, res) => {
    const agent = resolveAgent(req.body?.agent || req.query?.agent);
    const catalog = await buildQueryCatalog({ ...options, agent });
    if (isDryRunRequest(req)) {
      res.json({
        ok: true,
        dryRun: true,
        result: buildDryRunQueryResult(req, { agent, catalog, operation: 'run' }),
      });
      return;
    }
    if (!catalog.available) {
      res.status(503).json({ ok: false, unavailable: true, error: catalog.reason || 'query unavailable', catalog });
      return;
    }
    const brainId = req.body?.brainId || req.body?.routeKey || catalog.selectedBrain?.routeKey || catalog.selectedBrain?.id;
    if (!brainId) {
      res.status(400).json({ ok: false, unavailable: true, error: 'brainId required', catalog });
      return;
    }
    try {
      const cosmoBaseUrl = options.cosmoBaseUrl || getDefaultCosmoBaseUrl();
      const fetchImpl = options.fetchImpl || fetch;
      const upstream = await fetchImpl(`${String(cosmoBaseUrl).replace(/\/$/, '')}/api/brain/${encodeURIComponent(brainId)}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(Number(options.runTimeoutMs || 120000))
          : undefined,
      });
      const text = await upstream.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { answer: text }; }
      if (!upstream.ok || body?.error) {
        res.status(upstream.status || 502).json({
          ok: false,
          error: body?.error || body?.message || `upstream HTTP ${upstream.status}`,
          upstream: body,
        });
        return;
      }
      res.json({ ok: true, result: body });
    } catch (err) {
      res.status(502).json({ ok: false, unavailable: true, error: err.message || String(err) });
    }
  });

  router.post('/export', async (req, res) => {
    const agent = resolveAgent(req.body?.agent || req.query?.agent);
    const catalog = await buildQueryCatalog({ ...options, agent });
    if (isDryRunRequest(req)) {
      const result = buildDryRunQueryResult(req, { agent, catalog, operation: 'export' });
      res.json({
        success: true,
        dryRun: true,
        exportedTo: null,
        query: result.query,
        answer: result.answer,
        format: req.body?.format || req.body?.exportFormat || 'markdown',
        metadata: result.metadata,
      });
      return;
    }
    if (!catalog.available) {
      res.status(503).json({ success: false, unavailable: true, error: catalog.reason || 'query unavailable', catalog });
      return;
    }
    const brainId = req.body?.brainId || req.body?.routeKey || catalog.selectedBrain?.routeKey || catalog.selectedBrain?.id;
    if (!brainId) {
      res.status(400).json({ success: false, unavailable: true, error: 'brainId required', catalog });
      return;
    }
    try {
      const cosmoBaseUrl = options.cosmoBaseUrl || getDefaultCosmoBaseUrl();
      const fetchImpl = options.fetchImpl || fetch;
      const upstream = await fetchImpl(`${String(cosmoBaseUrl).replace(/\/$/, '')}/api/brain/${encodeURIComponent(brainId)}/export-query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(Number(options.exportTimeoutMs || 120000))
          : undefined,
      });
      const text = await upstream.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      if (!upstream.ok || body?.error) {
        res.status(upstream.status || 502).json({
          success: false,
          error: body?.error || body?.message || `upstream HTTP ${upstream.status}`,
          result: body,
        });
        return;
      }
      res.json({ success: body?.success ?? true, ...body });
    } catch (err) {
      res.status(502).json({ success: false, unavailable: true, error: err.message || String(err) });
    }
  });

  router.get('/stream', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'query stream requires POST body; facade stream proxy is not enabled yet' })}\n\n`);
    res.end();
  });

  return router;
}

function registerQueryApiRoutes(app, options = {}) {
  app.use('/home23/api/query', createQueryApiRouter(options));
}

module.exports = {
  DEFAULT_ENDPOINTS,
  buildQueryCatalog,
  createQueryApiRouter,
  registerQueryApiRoutes,
};
