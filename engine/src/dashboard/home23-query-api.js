const express = require('express');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  assertOperationId,
  assertResultHandle,
} = require('./brain-operations/operation-contract.js');

const DEFAULT_ENDPOINTS = {
  catalog: '/home23/api/query/catalog',
  run: '/home23/api/query/run',
  stream: '/home23/api/query/stream',
  export: '/home23/api/query/export',
  pgsPartitions: '/home23/api/query/pgs-partitions',
};

const MAX_QUERY_CHARS = 12_000;
const MAX_PRIOR_CONTEXT_CHARS = 20_000;
const MAX_AD_HOC_ANSWER_CHARS = 1_000_000;
const MAX_AGENT_SELECTOR_CHARS = 256;
const MAX_METADATA_JSON_BYTES = 64 * 1024;
const MAX_JSON_ESCAPED_UTF16_UNIT_BYTES = 6;
const MAX_AD_HOC_FIXED_BODY_BYTES = Buffer.byteLength(JSON.stringify({
  agent: '', query: '', answer: '', format: 'markdown', metadata: null,
  dryRun: true, validateOnly: true,
}), 'utf8') - Buffer.byteLength('null', 'utf8');
// This is the audited compact-JSON ceiling for every field-valid ad-hoc export:
// worst-case JSON escaping for all bounded strings, the full metadata JSON budget,
// and the fixed keys/punctuation/boolean controls. Requests above it are never needed.
const QUERY_COMPATIBILITY_BODY_LIMIT_BYTES = MAX_AD_HOC_FIXED_BODY_BYTES
  + MAX_JSON_ESCAPED_UTF16_UNIT_BYTES
    * (MAX_AGENT_SELECTOR_CHARS + MAX_QUERY_CHARS + MAX_AD_HOC_ANSWER_CHARS)
  + MAX_METADATA_JSON_BYTES;
const QUERY_WAIT_MS = 90 * 60_000;
const PGS_WAIT_MS = 6 * 60 * 60_000;
const SHORT_READ_WAIT_MS = 5 * 60_000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const QUERY_MODES = new Set(['quick', 'full', 'expert', 'dive']);
const PGS_MODES = new Set(['fresh', 'continue', 'targeted']);
const PGS_LEVEL_FRACTIONS = new Map([
  ['skim', 0.1],
  ['sample', 0.25],
  ['deep', 0.5],
  ['full', 1],
]);
const MAX_TARGET_PARTITION_IDS = 256;
const PARTITION_ID_PATTERN = /^(?:c|h)-[A-Za-z0-9._-]{1,253}$/;
const NONTERMINAL_STATES = new Set(['queued', 'running']);
const SUCCESS_STATES = new Set(['complete', 'partial']);
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

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

function buildResidentBrain(home23Root, agent) {
  if (!home23Root || !agent) return null;
  const brainPath = path.resolve(home23Root, 'instances', agent, 'brain');
  const canonicalRoot = fs.existsSync(brainPath)
    ? fs.realpathSync(brainPath)
    : brainPath;
  const config = readYaml(path.join(home23Root, 'instances', agent, 'config.yaml'));
  const displayName = config.agent?.displayName || config.agent?.name || agent;
  return {
    id: `brain-${crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)}`,
    routeKey: crypto.createHash('sha1').update(brainPath).digest('hex').slice(0, 16),
    name: 'brain',
    displayName: `${displayName} Brain`,
    path: brainPath,
    sourceLabel: agent,
    sourceType: 'home23-agent',
    isReference: false,
    isActive: fs.existsSync(brainPath),
    modifiedDate: null,
    topic: null,
  };
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
  const modelAuthorityPromise = Promise.resolve().then(() => {
    if (options.modelAuthorityProvider) {
      return options.modelAuthorityProvider({ agent, home23Root });
    }
    if (home23Root) {
      const { loadHome23ModelAuthority } = require('./home23-model-catalog.js');
      return loadHome23ModelAuthority({ home23Root, agent });
    }
    return null;
  });

  const residentBrainPromise = options.residentBrainProvider
    ? Promise.resolve().then(() => options.residentBrainProvider({ agent, home23Root }))
    : Promise.resolve(buildResidentBrain(home23Root, agent));
  const brainCatalogPromise = residentBrainPromise.then((residentBrain) => (
    residentBrain
      ? { brains: [residentBrain] }
      : fetchJson(fetchImpl, cosmoBaseUrl, '/api/brains', timeoutMs)
  ));
  const [statusResult, modelsResult, brainsResult] = await Promise.allSettled([
    fetchJson(fetchImpl, cosmoBaseUrl, '/api/status', timeoutMs),
    modelAuthorityPromise.then((authority) => (
      authority || fetchJson(fetchImpl, cosmoBaseUrl, '/api/providers/models', timeoutMs)
    )),
    brainCatalogPromise,
  ]);

  const statusError = statusResult.status === 'rejected' ? statusResult.reason : null;
  const modelError = modelsResult.status === 'rejected' ? modelsResult.reason : null;
  const brainError = brainsResult.status === 'rejected' ? brainsResult.reason : null;
  const modelAuthority = modelsResult.status === 'fulfilled' ? modelsResult.value : null;
  const models = modelAuthority ? normalizeModels(modelAuthority) : [];
  const queryDefaults = modelAuthority?.queryDefaults || (options.queryDefaultsProvider
    ? options.queryDefaultsProvider(agent)
    : loadQueryDefaults(home23Root, agent));
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
      pgsPartitions: DEFAULT_ENDPOINTS.pgsPartitions,
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
    streaming: !!options.operationAdapter,
    limits: {
      maxQueryChars: MAX_QUERY_CHARS,
      maxPriorContextChars: MAX_PRIOR_CONTEXT_CHARS,
    },
    lastRouteError: firstError ? (firstError.message || String(firstError)) : null,
  };
}

function compatibilityError(code, message = code, status = 400, retryable = false, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function createQueryCompatibilityBodyParser(options = {}) {
  if (!options || Array.isArray(options) || typeof options !== 'object'
      || Reflect.ownKeys(options).some((key) => key !== 'limitBytes')) {
    throw compatibilityError('invalid_request', 'query parser configuration is invalid');
  }
  const limitBytes = options.limitBytes ?? QUERY_COMPATIBILITY_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw compatibilityError('invalid_request', 'query parser limit is invalid');
  }
  const parser = express.json({ limit: limitBytes, strict: true });
  return (req, res, next) => {
    if (req.queryCompatibilityBodyParsed === true || !BODY_METHODS.has(req.method)) {
      return next();
    }
    return parser(req, res, (error) => {
      if (error) {
        const parsed = error.type === 'entity.too.large'
          ? compatibilityError('request_too_large', 'query request body is too large', 413)
          : compatibilityError('invalid_json', 'query request body is invalid JSON', 400);
        return sendCompatibilityError(
          res,
          parsed,
          req.path === '/export' ? 'export' : 'run',
        );
      }
      req.queryCompatibilityBodyParsed = true;
      return next();
    });
  };
}

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.ownKeys(value)
    : [];
}

function exactObject(value, allowed, message = 'request body must be an object') {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw compatibilityError('invalid_request', message);
  }
  const accepted = new Set(allowed);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw compatibilityError('invalid_request', 'request contains an unsupported field');
  }
  return value;
}

function boundedString(value, field, { required = false, max = 256 } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw compatibilityError('invalid_request', `${field} is invalid`);
  }
}

function normalizeAgentSelector(value, field = 'agent') {
  boundedString(value, field, { required: true, max: MAX_AGENT_SELECTOR_CHARS });
  const normalized = value.replace(/^home23-/, '').trim();
  if (!normalized) throw compatibilityError('invalid_request', `${field} is invalid`);
  return normalized;
}

function optionalBoolean(value, field) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw compatibilityError('invalid_request', `${field} must be a boolean`);
  }
}

function exactProviderPair(value, field) {
  if (value === undefined) return;
  exactObject(value, ['provider', 'model'], `${field} must be an exact provider/model pair`);
  if (ownKeys(value).length !== 2) {
    throw compatibilityError('invalid_request', `${field} must include provider and model`);
  }
  boundedString(value.provider, `${field}.provider`, { required: true, max: 256 });
  boundedString(value.model, `${field}.model`, { required: true, max: 256 });
}

function validateContinueFromOperationId(value) {
  boundedString(value, 'continueFromOperationId', { required: true, max: 256 });
  try { assertOperationId(value); } catch {
    throw compatibilityError('invalid_request', 'continueFromOperationId is invalid');
  }
  return value;
}

function validateTargetPartitionIds(value) {
  if (!Array.isArray(value)
      || value.length === 0
      || value.length > MAX_TARGET_PARTITION_IDS) {
    throw compatibilityError('invalid_request', 'targetPartitionIds is invalid');
  }
  const unique = new Set();
  for (const partitionId of value) {
    if (typeof partitionId !== 'string'
        || partitionId.length > 256
        || !PARTITION_ID_PATTERN.test(partitionId)
        || unique.has(partitionId)) {
      throw compatibilityError('invalid_request', 'targetPartitionIds is invalid');
    }
    unique.add(partitionId);
  }
  return [...value];
}

function validatePriorContext(value) {
  if (value === undefined) return;
  exactObject(value, ['query', 'answer'], 'priorContext is invalid');
  if (ownKeys(value).length !== 2
      || typeof value.query !== 'string'
      || typeof value.answer !== 'string') {
    throw compatibilityError('invalid_request', 'priorContext is invalid');
  }
  if (value.query.length + value.answer.length > MAX_PRIOR_CONTEXT_CHARS) {
    throw compatibilityError(
      'invalid_request',
      `priorContext exceeds ${MAX_PRIOR_CONTEXT_CHARS} characters`,
      413,
    );
  }
}

function validateSelectedBrain(body, catalog, agent) {
  const selected = catalog?.selectedBrain;
  const selectedId = selected?.id || selected?.routeKey;
  if (!selectedId || typeof selectedId !== 'string') {
    throw compatibilityError('target_unavailable', 'selected agent brain unavailable', 503, true);
  }
  if (catalog.agent !== undefined && catalog.agent !== null && catalog.agent !== agent) {
    throw compatibilityError('target_mismatch', 'catalog agent does not match the request', 400);
  }
  if (Object.hasOwn(body, 'brainId')) {
    boundedString(body.brainId, 'brainId', { required: true, max: 256 });
    if (body.brainId !== selected.id && body.brainId !== selected.routeKey) {
      throw compatibilityError(
        'target_mismatch',
        'agent and brainId do not select the same canonical brain',
        400,
      );
    }
  }
  if (Object.hasOwn(body, 'agent')) {
    if (normalizeAgentSelector(body.agent) !== agent) {
      throw compatibilityError('target_mismatch', 'request agent does not match the selected agent', 400);
    }
  }
  return selectedId;
}

function validateRouteQuery(req) {
  const allowed = new Set(['agent', 'dryRun', 'validateOnly']);
  for (const [key, value] of Object.entries(req.query || {})) {
    if (!allowed.has(key) || Array.isArray(value) || typeof value !== 'string') {
      throw compatibilityError('invalid_request', 'query parameters are invalid');
    }
    if (key === 'agent') normalizeAgentSelector(value, 'query agent');
  }
}

function resolveRequestAgent(req, resolveAgent) {
  const bodyAgent = req.body && !Array.isArray(req.body) && typeof req.body === 'object'
    && Object.hasOwn(req.body, 'agent')
    ? normalizeAgentSelector(req.body.agent, 'body agent')
    : null;
  const queryAgent = req.query && Object.hasOwn(req.query, 'agent')
    ? normalizeAgentSelector(req.query.agent, 'query agent')
    : null;
  if (bodyAgent && queryAgent && bodyAgent !== queryAgent) {
    throw compatibilityError(
      'target_mismatch',
      'query and body agent selectors disagree',
      400,
    );
  }
  const requested = bodyAgent || queryAgent;
  const resolvedValue = resolveAgent(requested || undefined);
  if (typeof resolvedValue !== 'string' || !resolvedValue.trim()) {
    throw compatibilityError('target_not_found', 'requested agent was not found', 404);
  }
  const resolved = normalizeAgentSelector(resolvedValue, 'resolved agent');
  if (requested && resolved !== requested) {
    throw compatibilityError('target_not_found', 'requested agent was not found', 404);
  }
  return resolved;
}

function validateCompatibilityRequest(body, catalog, agent) {
  const common = [
    'agent', 'brainId', 'query', 'enablePGS',
    'dryRun', 'validateOnly',
  ];
  const direct = [
    'mode', 'modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions', 'topK', 'priorContext',
  ];
  const pgs = [
    'pgsMode', 'pgsLevel', 'continueFromOperationId', 'targetPartitionIds',
    'pgsSweep', 'pgsSynth',
  ];
  exactObject(body, [...common, ...direct, ...pgs]);
  const targetBrainId = validateSelectedBrain(body, catalog, agent);
  boundedString(body.query, 'query', { required: true, max: Number.MAX_SAFE_INTEGER });
  if (body.query.length > MAX_QUERY_CHARS) {
    throw compatibilityError(
      'invalid_request',
      `query exceeds ${MAX_QUERY_CHARS} characters`,
      413,
    );
  }
  if (body.mode !== undefined && !QUERY_MODES.has(body.mode)) {
    throw compatibilityError('invalid_request', 'mode is invalid');
  }
  optionalBoolean(body.enablePGS, 'enablePGS');
  const enablePGS = body.enablePGS === true;

  if (enablePGS) {
    if (direct.some((key) => Object.hasOwn(body, key))) {
      throw compatibilityError('invalid_request', 'direct-query fields are invalid for PGS');
    }
    if (!Object.hasOwn(body, 'pgsSweep') || !Object.hasOwn(body, 'pgsSynth')) {
      throw compatibilityError('invalid_request', 'PGS requires exact sweep and synthesis pairs');
    }
    exactProviderPair(body.pgsSweep, 'pgsSweep');
    exactProviderPair(body.pgsSynth, 'pgsSynth');
    if (!PGS_MODES.has(body.pgsMode)) {
      throw compatibilityError('invalid_request', 'pgsMode is invalid');
    }
    const sweepFraction = PGS_LEVEL_FRACTIONS.get(body.pgsLevel);
    if (sweepFraction === undefined) {
      throw compatibilityError('invalid_request', 'pgsLevel is invalid');
    }
    const hasContinuation = Object.hasOwn(body, 'continueFromOperationId');
    const hasTargets = Object.hasOwn(body, 'targetPartitionIds');
    let continueFromOperationId;
    let targetPartitionIds;
    if (body.pgsMode === 'fresh') {
      if (hasContinuation || hasTargets) {
        throw compatibilityError('invalid_request', 'fresh PGS cannot continue or target partitions');
      }
    } else if (body.pgsMode === 'continue') {
      if (!hasContinuation || hasTargets) {
        throw compatibilityError('invalid_request', 'continue PGS requires only a prior operation');
      }
      continueFromOperationId = validateContinueFromOperationId(body.continueFromOperationId);
    } else {
      if (!hasTargets) {
        throw compatibilityError('invalid_request', 'targeted PGS requires targetPartitionIds');
      }
      targetPartitionIds = validateTargetPartitionIds(body.targetPartitionIds);
      if (hasContinuation) {
        continueFromOperationId = validateContinueFromOperationId(body.continueFromOperationId);
      }
    }
    return {
      operationType: 'pgs',
      targetBrainId,
      parameters: {
        query: body.query,
        pgsMode: body.pgsMode,
        pgsLevel: body.pgsLevel,
        pgsConfig: { sweepFraction },
        ...(continueFromOperationId !== undefined ? { continueFromOperationId } : {}),
        ...(targetPartitionIds !== undefined ? { targetPartitionIds } : {}),
        pgsSweep: body.pgsSweep,
        pgsSynth: body.pgsSynth,
      },
    };
  }

  if (pgs.some((key) => Object.hasOwn(body, key))) {
    throw compatibilityError('invalid_request', 'PGS fields require enablePGS true');
  }
  exactProviderPair(body.modelSelection, 'modelSelection');
  validatePriorContext(body.priorContext);
  for (const field of [
    'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions',
  ]) optionalBoolean(body[field], field);
  if (body.topK !== undefined
      && (!Number.isSafeInteger(body.topK) || body.topK < 1 || body.topK > 100)) {
    throw compatibilityError('invalid_request', 'topK is invalid');
  }
  return {
    operationType: 'query',
    targetBrainId,
    parameters: {
      query: body.query,
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.modelSelection !== undefined ? { modelSelection: body.modelSelection } : {}),
      ...(body.enableSynthesis !== undefined ? { enableSynthesis: body.enableSynthesis } : {}),
      ...(body.includeOutputs !== undefined ? { includeOutputs: body.includeOutputs } : {}),
      ...(body.includeThoughts !== undefined ? { includeThoughts: body.includeThoughts } : {}),
      ...(body.includeCoordinatorInsights !== undefined
        ? { includeCoordinatorInsights: body.includeCoordinatorInsights } : {}),
      ...(body.allowActions !== undefined ? { allowActions: body.allowActions } : {}),
      ...(body.topK !== undefined ? { topK: body.topK } : {}),
      ...(body.priorContext !== undefined ? { priorContext: body.priorContext } : {}),
    },
  };
}

function validateMetadata(value) {
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw compatibilityError('invalid_request', 'metadata is invalid');
  }
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw compatibilityError('invalid_request', 'metadata is invalid');
  }
  if (serialized === undefined
      || Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_JSON_BYTES) {
    throw compatibilityError('invalid_request', 'metadata is invalid');
  }
  return JSON.parse(serialized);
}

function validateExportRequest(body, catalog, agent) {
  const common = ['agent', 'brainId', 'format', 'dryRun', 'validateOnly'];
  const canonical = ['operationId', 'resultHandle', 'fileName'];
  const adHoc = ['query', 'answer', 'metadata'];
  exactObject(body, [...common, ...canonical, ...adHoc]);
  if (catalog) validateSelectedBrain(body, catalog, agent);
  else if (Object.hasOwn(body, 'brainId')) {
    throw compatibilityError(
      'invalid_request',
      'canonical export target is derived from the stored operation',
    );
  }
  const isCanonical = Object.hasOwn(body, 'operationId');
  if (isCanonical) {
    if (adHoc.some((key) => Object.hasOwn(body, key))) {
      throw compatibilityError('invalid_request', 'canonical export cannot accept inline result bytes');
    }
    boundedString(body.operationId, 'operationId', { required: true, max: 256 });
    try { assertOperationId(body.operationId); } catch {
      throw compatibilityError('invalid_request', 'operationId is invalid');
    }
    boundedString(body.resultHandle, 'resultHandle', { max: 256 });
    if (body.resultHandle !== undefined) {
      try { assertResultHandle(body.resultHandle); } catch {
        throw compatibilityError('invalid_request', 'resultHandle is invalid');
      }
    }
    boundedString(body.fileName, 'fileName', { max: 128 });
    if (!['markdown', 'json', 'jsonl'].includes(body.format)) {
      throw compatibilityError('invalid_request', 'format is invalid');
    }
    return {
      kind: 'canonical',
      operationId: body.operationId,
      ...(body.resultHandle !== undefined ? { resultHandle: body.resultHandle } : {}),
      format: body.format,
      ...(body.fileName !== undefined ? { fileName: body.fileName } : {}),
    };
  }
  if (canonical.some((key) => Object.hasOwn(body, key))) {
    throw compatibilityError('invalid_request', 'ad hoc export cannot use a stored result handle');
  }
  boundedString(body.query, 'query', { required: true, max: MAX_QUERY_CHARS });
  boundedString(body.answer, 'answer', { required: true, max: MAX_AD_HOC_ANSWER_CHARS });
  if (!['markdown', 'json'].includes(body.format)) {
    throw compatibilityError('invalid_request', 'format is invalid');
  }
  return {
    kind: 'ad_hoc',
    query: body.query,
    answer: body.answer,
    format: body.format,
    metadata: validateMetadata(body.metadata),
  };
}

function requestId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function catalogFor(options, agent) {
  const catalog = options.catalogProvider
    ? await options.catalogProvider({ agent })
    : await buildQueryCatalog({ ...options, agent });
  if (!catalog || Array.isArray(catalog) || typeof catalog !== 'object') {
    throw compatibilityError('catalog_unavailable', 'query catalog is unavailable', 503, true);
  }
  return catalog;
}

function operationAdapter(options) {
  const adapter = options.operationAdapter;
  if (!adapter || ['start', 'attachAndWait', 'getResult', 'detach', 'exportStored']
    .some((method) => typeof adapter[method] !== 'function')) {
    throw compatibilityError(
      'operation_adapter_unavailable',
      'durable brain operation adapter is unavailable',
      503,
      true,
    );
  }
  return adapter;
}

function typedError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'query_operation_failed';
  return {
    code,
    message: typeof error?.message === 'string' && error.message ? error.message : code,
    retryable: error?.retryable === true,
  };
}

function isTypedOperationError(error) {
  return Boolean(error
    && typeof error.code === 'string' && error.code.trim()
    && typeof error.message === 'string' && error.message.trim()
    && typeof error.retryable === 'boolean');
}

function operationResultError(
  envelope,
  code,
  message,
  status = 502,
  retryable = true,
) {
  const error = compatibilityError(code, message, status, retryable);
  error.operation = envelope;
  return error;
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.code === 'access_denied') return 403;
  if (['operation_not_found', 'result_not_found', 'target_not_found'].includes(error?.code)) return 404;
  if (error?.code === 'result_expired') return 410;
  if (error?.code === 'request_too_large') return 413;
  if (error?.retryable === true) return 503;
  return 500;
}

function operationReferenceFromError(error) {
  const operation = error?.operation && typeof error.operation === 'object'
    ? error.operation
    : error?.operationId ? error : null;
  if (!operation || typeof operation.operationId !== 'string'
      || typeof operation.state !== 'string') return null;
  return {
    operationId: operation.operationId,
    state: operation.state,
    attachmentState: operation.attachmentState
      || (TERMINAL_STATES.has(operation.state) ? 'closed' : 'attached'),
    detached: false,
    resultHandle: operation.resultHandle ?? null,
    resultArtifact: operation.resultArtifact ?? null,
    sourceEvidence: operation.sourceEvidence ?? null,
  };
}

function compatibilityFailurePayload(error, responseKind = 'run') {
  return {
    ...(responseKind === 'export' ? { success: false } : { ok: false }),
    ...(operationReferenceFromError(error) || {}),
    error: typedError(error),
  };
}

function sendCompatibilityError(res, error, responseKind = 'run') {
  return res.status(errorStatus(error)).json(compatibilityFailurePayload(error, responseKind));
}

function detachedPayload(record) {
  const id = record.operationId;
  const base = `/home23/api/brain-operations/${encodeURIComponent(id)}`;
  return {
    ok: false,
    operationId: id,
    state: record.state,
    attachmentState: 'detached',
    detached: true,
    guidance: {
      resume: `Reconnect using operationId ${id}; the durable operation is still running.`,
      status: `GET ${base}`,
      result: `GET ${base}/result`,
      cancel: `POST ${base}/cancel`,
    },
  };
}

function statusEvent(record) {
  const sequence = record?.eventSequence ?? record?.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw compatibilityError('event_stream_invalid', 'operation event sequence is invalid', 502, true);
  }
  const event = {
    type: record.type || 'status',
    operationId: record.operationId,
    state: record.state || null,
    phase: record.phase || null,
    eventSequence: sequence,
    updatedAt: record.updatedAt || record.at || null,
  };
  for (const field of ['stage', 'message', 'provider', 'model', 'providerCallId']) {
    if (typeof record[field] === 'string' && record[field].length > 0
        && record[field].length <= 4096) event[field] = record[field];
  }
  for (const field of [
    'batchIndex', 'selectedWorkUnits', 'selectedWorkUnitsTotal',
    'candidateWorkUnits', 'pendingWorkUnits', 'successfulSweeps',
    'scopeWorkUnits', 'scopeSuccessfulWorkUnits', 'scopePendingWorkUnits',
    'globalCoveredWorkUnits', 'globalPendingWorkUnits',
  ]) {
    if (Number.isSafeInteger(record[field]) && record[field] >= 0) {
      event[field] = record[field];
    }
  }
  return event;
}

function terminalPayload(envelope) {
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object'
      || !TERMINAL_STATES.has(envelope.state)) {
    throw compatibilityError('operation_contract_invalid', 'terminal operation status is invalid', 502, true);
  }
  if (!SUCCESS_STATES.has(envelope.state)) {
    if (!isTypedOperationError(envelope.error)) {
      throw operationResultError(
        envelope,
        'operation_contract_invalid',
        'terminal operation error is invalid',
        502,
        true,
      );
    }
    const failure = compatibilityError(
      envelope.error.code,
      envelope.error.message,
      envelope.state === 'cancelled' ? 409 : 502,
      envelope.error.retryable,
    );
    failure.operation = envelope;
    throw failure;
  }
  const result = envelope.result;
  if (!result || Array.isArray(result) || typeof result !== 'object'
      || result.success === false || (Object.hasOwn(result, 'error') && result.error !== null)) {
    throw operationResultError(
      envelope,
      'result_invalid',
      'terminal operation result is invalid',
    );
  }
  const answer = result.answer;
  const typedPartialError = isTypedOperationError(envelope.error);
  if (envelope.state === 'complete') {
    if (envelope.error !== null || typeof answer !== 'string' || !answer.trim()) {
      throw operationResultError(
        envelope,
        'result_missing',
        'terminal operation has no answer',
      );
    }
  } else if (envelope.operationType === 'query') {
    if (!typedPartialError || typeof answer !== 'string' || !answer.trim()) {
      throw operationResultError(
        envelope,
        'result_invalid',
        'partial query result is invalid',
      );
    }
  } else if (envelope.operationType === 'pgs') {
    const sweepOutputs = result.sweepOutputs;
    const pgs = result.metadata && typeof result.metadata === 'object'
      ? result.metadata.pgs
      : null;
    const retryablePartitions = pgs?.retryablePartitions;
    const validSweep = (sweep) => sweep && !Array.isArray(sweep) && typeof sweep === 'object'
      && Object.keys(sweep).sort().join(',') === 'model,output,partitionId,provider,workUnitId'
      && ['workUnitId', 'partitionId', 'output', 'provider', 'model'].every((key) =>
        typeof sweep[key] === 'string' && Boolean(sweep[key].trim()));
    const validRetryable = Array.isArray(retryablePartitions)
      && retryablePartitions.every((value) => typeof value === 'string' && Boolean(value.trim()))
      && new Set(retryablePartitions).size === retryablePartitions.length
      && retryablePartitions.every((value, index) =>
        index === 0 || retryablePartitions[index - 1] < value);
    if (!typedPartialError
        || !Array.isArray(sweepOutputs) || sweepOutputs.length === 0
        || !sweepOutputs.every(validSweep)
        || !Number.isSafeInteger(pgs?.successfulSweeps)
        || pgs.successfulSweeps !== sweepOutputs.length
        || !validRetryable
        || !((answer === null) || (typeof answer === 'string' && answer.trim()))) {
      throw operationResultError(
        envelope,
        'result_invalid',
        'partial PGS result is invalid',
      );
    }
  } else {
    throw operationResultError(
      envelope,
      'result_invalid',
      'partial operation type is invalid',
    );
  }
  return {
    ok: true,
    operationId: envelope.operationId,
    state: envelope.state,
    attachmentState: 'closed',
    detached: false,
    resultHandle: envelope.resultHandle ?? null,
    resultArtifact: envelope.resultArtifact ?? null,
    sourceEvidence: envelope.sourceEvidence ?? null,
    result,
    answer,
    ...(envelope.error ? { error: envelope.error } : {}),
    ...(result.sweepOutputs !== undefined ? { sweepOutputs: result.sweepOutputs } : {}),
    ...(result.query !== undefined ? { query: result.query } : {}),
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
  };
}

async function startAndWait(options, request, { signal, onEvent } = {}) {
  const adapter = operationAdapter(options);
  const started = await adapter.start(request);
  if (!started || !NONTERMINAL_STATES.has(started.state)
      || started.operationType !== request.operationType) {
    throw compatibilityError('operation_contract_invalid', 'operation did not start durably', 502, true);
  }
  const attachmentId = requestId('compat-attachment');
  const waitMs = started.operationType === 'pgs'
    ? PGS_WAIT_MS
    : started.operationType === 'query' ? QUERY_WAIT_MS : SHORT_READ_WAIT_MS;
  const status = await adapter.attachAndWait(started, {
    attachmentId,
    signal,
    waitMs,
    onEvent: onEvent || (() => {}),
  });
  if (status?.operationId !== started.operationId) {
    throw compatibilityError('operation_contract_invalid', 'operation wait changed identity', 502, true);
  }
  if (status?.attachmentState === 'detached' && NONTERMINAL_STATES.has(status.state)) {
    return { detached: status };
  }
  if (!status || !TERMINAL_STATES.has(status.state)) {
    throw compatibilityError('operation_contract_invalid', 'operation wait returned invalid state', 502, true);
  }
  const envelope = await adapter.getResult(started.operationId);
  if (envelope?.operationId !== started.operationId) {
    throw compatibilityError('operation_contract_invalid', 'operation result changed identity', 502, true);
  }
  if (envelope?.operationType !== undefined
      && envelope.operationType !== request.operationType) {
    throw operationResultError(
      envelope,
      'operation_contract_invalid',
      'operation result changed type',
    );
  }
  return { envelope: { ...envelope, operationType: request.operationType } };
}

function createQueryApiRouter(options = {}) {
  const router = express.Router();
  router.use(createQueryCompatibilityBodyParser());
  const resolveAgent = options.resolveAgent || ((candidate) => {
    if (options.home23Root) {
      return resolveAgentFromRoot(options.home23Root, candidate, options.getDefaultAgent?.() || 'jerry');
    }
    return candidate || options.getDefaultAgent?.() || 'jerry';
  });

  router.get('/catalog', async (req, res) => {
    try {
      validateRouteQuery(req);
      const agent = resolveRequestAgent(req, resolveAgent);
      const catalog = await catalogFor(options, agent);
      res.json(catalog);
    } catch (err) {
      res.status(500).json({
        agent: req.query?.agent || options.getDefaultAgent?.() || null,
        available: false,
        reason: 'query catalog error',
        endpoints: {
          run: DEFAULT_ENDPOINTS.run,
          stream: DEFAULT_ENDPOINTS.stream,
          export: DEFAULT_ENDPOINTS.export,
          pgsPartitions: DEFAULT_ENDPOINTS.pgsPartitions,
        },
        models: [],
        defaults: null,
        brains: [],
        selectedBrain: null,
        cosmo: normalizeCosmoStatus(null, err),
        streaming: false,
        limits: {
          maxQueryChars: MAX_QUERY_CHARS,
          maxPriorContextChars: MAX_PRIOR_CONTEXT_CHARS,
        },
        lastRouteError: err.message || String(err),
      });
    }
  });

  router.post('/run', async (req, res) => {
    let responseFinished = false;
    const controller = new AbortController();
    res.once('close', () => {
      if (!responseFinished && !controller.signal.aborted) {
        controller.abort(compatibilityError('caller_disconnected', 'query caller disconnected', 499));
      }
    });
    try {
      validateRouteQuery(req);
      const agent = resolveRequestAgent(req, resolveAgent);
      const catalog = await catalogFor(options, agent);
      if (!catalog.available) {
        throw compatibilityError(
          'query_unavailable',
          catalog.reason || 'query unavailable',
          503,
          true,
        );
      }
      const normalized = validateCompatibilityRequest(req.body, catalog, agent);
      if (isDryRunRequest(req)) {
        responseFinished = true;
        res.json({
          ok: true,
          dryRun: true,
          result: buildDryRunQueryResult(req, { agent, catalog, operation: 'run' }),
        });
        return;
      }
      const outcome = await startAndWait(options, {
        requestId: requestId('compat-query'),
        operationType: normalized.operationType,
        target: { brainId: normalized.targetBrainId },
        parameters: normalized.parameters,
      }, { signal: controller.signal });
      responseFinished = true;
      if (outcome.detached) {
        res.status(202).json(detachedPayload(outcome.detached));
        return;
      }
      res.json(terminalPayload(outcome.envelope));
    } catch (err) {
      responseFinished = true;
      if (!res.headersSent) sendCompatibilityError(res, err);
      else res.end();
    }
  });

  router.post('/pgs-partitions', async (req, res) => {
    let responseFinished = false;
    const controller = new AbortController();
    res.once('close', () => {
      if (!responseFinished && !controller.signal.aborted) {
        controller.abort(compatibilityError('caller_disconnected', 'partition caller disconnected', 499));
      }
    });
    try {
      validateRouteQuery(req);
      exactObject(req.body, ['agent', 'brainId']);
      const agent = resolveRequestAgent(req, resolveAgent);
      const catalog = await catalogFor(options, agent);
      const targetBrainId = validateSelectedBrain(req.body, catalog, agent);
      const outcome = await startAndWait(options, {
        requestId: requestId('compat-pgs-partitions'),
        operationType: 'graph',
        target: { brainId: targetBrainId },
        parameters: { view: 'pgs_partitions' },
      }, { signal: controller.signal });
      responseFinished = true;
      if (outcome.detached) {
        res.status(202).json(detachedPayload(outcome.detached));
        return;
      }
      const envelope = outcome.envelope;
      const result = envelope?.result;
      if (envelope?.state !== 'complete' || envelope.error !== null
          || !result || Array.isArray(result) || typeof result !== 'object'
          || result.complete !== true || !Array.isArray(result.partitions)
          || result.partitions.some((row) => !row || typeof row !== 'object'
            || typeof row.partitionId !== 'string'
            || !PARTITION_ID_PATTERN.test(row.partitionId)
            || !Number.isSafeInteger(row.nodeCount) || row.nodeCount < 1
            || !Number.isSafeInteger(row.estimatedWorkUnits) || row.estimatedWorkUnits < 1)) {
        throw compatibilityError('result_invalid', 'PGS partition inventory is invalid', 502, true);
      }
      res.json({
        ok: true,
        operationId: envelope.operationId,
        sourceEvidence: envelope.sourceEvidence ?? result.evidence ?? null,
        ...result,
      });
    } catch (err) {
      responseFinished = true;
      if (!res.headersSent) sendCompatibilityError(res, err);
      else res.end();
    }
  });

  router.post('/stream', async (req, res) => {
    let responseFinished = false;
    let headersSent = false;
    const controller = new AbortController();
    res.once('close', () => {
      if (!responseFinished && !controller.signal.aborted) {
        controller.abort(compatibilityError('caller_disconnected', 'stream caller disconnected', 499));
      }
    });
    try {
      validateRouteQuery(req);
      const agent = resolveRequestAgent(req, resolveAgent);
      const catalog = await catalogFor(options, agent);
      if (!catalog.available) {
        throw compatibilityError(
          'query_unavailable',
          catalog.reason || 'query unavailable',
          503,
          true,
        );
      }
      const normalized = validateCompatibilityRequest(req.body, catalog, agent);
      if (isDryRunRequest(req)) {
        responseFinished = true;
        res.json({
          ok: true,
          dryRun: true,
          result: buildDryRunQueryResult(req, { agent, catalog, operation: 'stream' }),
        });
        return;
      }
      operationAdapter(options);
      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders?.();
      headersSent = true;
      let lastSequence = 0;
      const send = (payload) => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };
      const outcome = await startAndWait(options, {
        requestId: requestId('compat-stream'),
        operationType: normalized.operationType,
        target: { brainId: normalized.targetBrainId },
        parameters: normalized.parameters,
      }, {
        signal: controller.signal,
        onEvent: (event) => {
          const projected = statusEvent(event);
          if (projected.eventSequence <= lastSequence) return;
          lastSequence = projected.eventSequence;
          send(projected);
        },
      });
      if (outcome.detached) {
        send({ type: 'detached', ...detachedPayload(outcome.detached) });
      } else {
        send({ type: 'result', ...terminalPayload(outcome.envelope) });
      }
      responseFinished = true;
      res.end();
    } catch (err) {
      responseFinished = true;
      if (!headersSent && !res.headersSent) {
        sendCompatibilityError(res, err);
      } else if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          ...compatibilityFailurePayload(err),
        })}\n\n`);
        res.end();
      }
    }
  });

  router.post('/export', async (req, res) => {
    try {
      validateRouteQuery(req);
      const agent = resolveRequestAgent(req, resolveAgent);
      const catalog = null;
      const normalized = validateExportRequest(req.body, catalog, agent);
      if (isDryRunRequest(req)) {
        const result = buildDryRunQueryResult(req, { agent, catalog, operation: 'export' });
        res.json({
          success: true,
          dryRun: true,
          canonicalEvidence: normalized.kind === 'canonical',
          exportedTo: null,
          query: normalized.query || result.query,
          answer: normalized.answer || result.answer,
          format: normalized.format,
          metadata: result.metadata,
        });
        return;
      }
      const result = await operationAdapter(options).exportStored({
        ...normalized,
        ...(normalized.kind === 'ad_hoc' ? { requestId: requestId('compat-export') } : {}),
      });
      if (!result || Array.isArray(result) || typeof result !== 'object'
          || result.success === false || (Object.hasOwn(result, 'error') && result.error !== null)
          || result.attachmentState === 'detached') {
        if (result?.attachmentState === 'detached' && result.operationId) {
          res.status(202).json({
            success: false,
            ...detachedPayload(result),
            canonicalEvidence: false,
          });
          return;
        }
        throw compatibilityError('export_failed', 'brain export did not complete', 502, true);
      }
      res.json({ success: true, ...result });
    } catch (err) {
      if (!res.headersSent) sendCompatibilityError(res, err, 'export');
      else res.end();
    }
  });

  router.get('/stream', (_req, res) => {
    res.status(405).json({
      ok: false,
      error: {
        code: 'method_not_allowed',
        message: 'query stream requires POST',
        retryable: false,
      },
    });
  });

  return router;
}

function registerQueryApiRoutes(app, options = {}) {
  app.use('/home23/api/query', createQueryApiRouter(options));
}

module.exports = {
  DEFAULT_ENDPOINTS,
  QUERY_COMPATIBILITY_BODY_LIMIT_BYTES,
  buildQueryCatalog,
  createQueryCompatibilityBodyParser,
  createQueryApiRouter,
  registerQueryApiRoutes,
};
