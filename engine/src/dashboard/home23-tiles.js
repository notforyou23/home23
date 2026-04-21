const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Sensor registry — optional. We lazy-load to keep tiles decoupled from the
// engine's internal modules. If the engine/src/sensors module isn't present
// (e.g. dashboard-only deploys), publishing is a no-op.
let _sensorRegistry = null;
function getRegistry() {
  if (_sensorRegistry === null) {
    try { _sensorRegistry = require('../sensors/registry'); }
    catch { _sensorRegistry = false; }
  }
  return _sensorRegistry || null;
}

function publishTileSensor(tile, mode, data, valueSummary) {
  const reg = getRegistry();
  if (!reg) return;
  try {
    reg.publish({
      id: `tile.${tile.id}`,
      label: tile.title || tile.id,
      category: 'tile',
      source: `tile:${mode}`,
      value: valueSummary,
      data,
      ok: true,
    });
  } catch { /* non-fatal */ }
}

const TILE_SIZES = ['third', 'half', 'full'];
const GENERIC_AUTH_TYPES = ['none', 'basic', 'bearer', 'header'];
const SAUNA_LOG_PATH = path.join(process.env.HOME || '/Users/jtr', '.sauna_usage_log.jsonl');
let _prevSaunaState = null; // for usage transition detection

function logSaunaEvent(event, saunaData) {
  try {
    fs.appendFileSync(SAUNA_LOG_PATH, JSON.stringify({ event, ts: new Date().toISOString(), temp: saunaData.temperature, targetTemp: saunaData.targetTemperature, status: saunaData.status }) + '\n');
  } catch (e) {
    console.warn('[TILES] Sauna usage log write failed:', e.message);
  }
}

const CORE_TILES = [
  {
    id: 'thought-feed',
    kind: 'core',
    title: 'Thought Feed',
    icon: '🌊',
    mode: 'core-thought-feed',
    description: 'Latest thought rotation from this dashboard agent.',
    sizeDefault: 'third',
    refreshMs: 30_000,
  },
  {
    id: 'vibe',
    kind: 'core',
    title: 'Vibe',
    icon: '🎨',
    mode: 'core-vibe',
    description: 'Current dashboard vibe image and gallery link.',
    sizeDefault: 'third',
    refreshMs: 30_000,
  },
  {
    id: 'chat',
    kind: 'core',
    title: 'Chat',
    icon: '💬',
    mode: 'core-chat',
    description: 'Native dashboard chat to this dashboard agent.',
    sizeDefault: 'third',
    refreshMs: 30_000,
  },
  {
    id: 'system-summary',
    kind: 'core',
    title: 'System Summary',
    icon: '⚡',
    mode: 'core-system-summary',
    description: 'Home23 uptime, thought count, node count, and freshness.',
    sizeDefault: 'full',
    refreshMs: 30_000,
  },
  {
    id: 'brain-log',
    kind: 'core',
    title: 'Brain Log',
    icon: '🧠',
    mode: 'core-brain-log',
    description: 'Recent brain thought stream.',
    sizeDefault: 'half',
    refreshMs: 30_000,
  },
  {
    id: 'dream-log',
    kind: 'core',
    title: 'Dream Log',
    icon: '💭',
    mode: 'core-dream-log',
    description: 'Recent dream narratives.',
    sizeDefault: 'half',
    refreshMs: 30_000,
  },
  {
    id: 'feeder',
    kind: 'core',
    title: 'Ingestion Compiler',
    icon: '📥',
    mode: 'core-feeder',
    description: 'Live feeder and compiler health.',
    sizeDefault: 'full',
    refreshMs: 30_000,
  },
];

const TILE_TEMPLATES = [
  {
    mode: 'ecowitt-weather',
    label: 'Ecowitt Weather',
    description: 'Live weather tile backed by an Ecowitt cloud connection.',
    connectionType: 'ecowitt',
    icon: '🌤',
  },
  {
    mode: 'huum-sauna',
    label: 'Huum Sauna',
    description: 'Live sauna status with start/stop controls.',
    connectionType: 'huum',
    icon: '♨️',
  },
  {
    mode: 'generic-http-json',
    label: 'Generic HTTP JSON',
    description: 'Advanced HTTP/JSON tile with field mapping and actions.',
    connectionType: 'generic-http',
    icon: '🧩',
  },
];

const CONNECTION_TYPES = [
  {
    type: 'ecowitt',
    label: 'Ecowitt Weather',
    description: 'Ecowitt cloud device connection.',
    secretFields: ['applicationKey', 'apiKey', 'mac'],
    configFields: [],
  },
  {
    type: 'huum',
    label: 'Huum Sauna',
    description: 'Huum controller HTTP API connection.',
    secretFields: ['username', 'password'],
    configFields: ['baseUrl'],
  },
  {
    type: 'generic-http',
    label: 'Generic HTTP',
    description: 'Reusable HTTP connection with auth and base URL.',
    secretFields: ['username', 'password', 'bearerToken', 'headerValue'],
    configFields: ['baseUrl', 'authType', 'headerName', 'headers'],
  },
];

function loadYaml(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
}

function saveYaml(filePath, data) {
  fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: 120 }), 'utf8');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 10) return '••••';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function stringifyValue(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getCoreTileMap() {
  return new Map(CORE_TILES.map((tile) => [tile.id, deepClone(tile)]));
}

function getTemplateMap() {
  return new Map(TILE_TEMPLATES.map((template) => [template.mode, template]));
}

function getConnectionTypeMap() {
  return new Map(CONNECTION_TYPES.map((type) => [type.type, type]));
}

function normalizeTileSize(size, fallback = 'third') {
  return TILE_SIZES.includes(size) ? size : fallback;
}

function defaultHomeLayout() {
  return CORE_TILES.map((tile) => ({
    tileId: tile.id,
    enabled: true,
    size: tile.sizeDefault,
  }));
}

function defaultRefreshForMode(mode) {
  if (mode === 'huum-sauna') return 15_000;
  if (mode === 'ecowitt-weather') return 60_000;
  return 30_000;
}

function defaultIconForMode(mode) {
  const template = getTemplateMap().get(mode);
  return template?.icon || '🧩';
}

function normalizeMetrics(metrics) {
  if (!Array.isArray(metrics)) return [];
  return metrics
    .map((metric) => ({
      label: String(metric?.label || '').trim(),
      path: String(metric?.path || '').trim(),
    }))
    .filter((metric) => metric.label && metric.path)
    .slice(0, 8);
}

function normalizeActionField(field) {
  const id = slugify(field?.id || field?.name || field?.label || 'field');
  const type = ['text', 'number', 'boolean'].includes(field?.type) ? field.type : 'text';
  return {
    id,
    label: String(field?.label || field?.name || id).trim(),
    type,
    defaultValue: field?.defaultValue ?? field?.default ?? (type === 'boolean' ? false : ''),
    required: field?.required === true,
  };
}

function normalizeGenericAction(action) {
  const id = slugify(action?.id || action?.label || 'action');
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(action?.method || '').toUpperCase())
    ? String(action.method).toUpperCase()
    : 'POST';
  const fields = Array.isArray(action?.fields) ? action.fields.map(normalizeActionField) : [];

  let bodyTemplate = {};
  if (action?.bodyTemplate && typeof action.bodyTemplate === 'object' && !Array.isArray(action.bodyTemplate)) {
    bodyTemplate = deepClone(action.bodyTemplate);
  } else {
    fields.forEach((field) => {
      bodyTemplate[field.id] = `$${field.id}`;
    });
  }

  return {
    id,
    label: String(action?.label || id).trim(),
    method,
    path: String(action?.path || '').trim(),
    confirmationText: String(action?.confirmationText || '').trim(),
    fields,
    bodyTemplate,
  };
}

function normalizeTileModeConfig(mode, config = {}) {
  if (mode === 'huum-sauna') {
    return {
      startDefaults: {
        targetTemperature: clampNumber(config?.startDefaults?.targetTemperature, 100, 240, 190),
        duration: clampNumber(config?.startDefaults?.duration, 15, 720, 180),
      },
    };
  }

  if (mode === 'generic-http-json') {
    return {
      request: {
        path: String(config?.request?.path || '/').trim() || '/',
        method: 'GET',
      },
      display: {
        valuePath: String(config?.display?.valuePath || '').trim(),
        statusPath: String(config?.display?.statusPath || '').trim(),
        subtitlePath: String(config?.display?.subtitlePath || '').trim(),
        metrics: normalizeMetrics(config?.display?.metrics),
      },
      actions: Array.isArray(config?.actions) ? config.actions.map(normalizeGenericAction).filter((action) => action.path) : [],
    };
  }

  return {};
}

function normalizeCustomTile(tile) {
  const mode = getTemplateMap().has(tile?.mode) ? tile.mode : 'generic-http-json';
  const fallbackTitle = getTemplateMap().get(mode)?.label || 'Custom Tile';
  const id = slugify(tile?.id || tile?.title || '');
  const safeId = id || `tile-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id: safeId,
    kind: 'custom',
    title: String(tile?.title || fallbackTitle).trim() || fallbackTitle,
    icon: String(tile?.icon || defaultIconForMode(mode)).trim() || defaultIconForMode(mode),
    mode,
    connectionId: String(tile?.connectionId || '').trim(),
    refreshMs: clampNumber(tile?.refreshMs, 5_000, 3_600_000, defaultRefreshForMode(mode)),
    sizeDefault: normalizeTileSize(tile?.sizeDefault, mode === 'generic-http-json' ? 'half' : 'third'),
    config: normalizeTileModeConfig(mode, tile?.config || {}),
  };
}

function normalizeDashboardTilesConfig(stored = {}) {
  const customTiles = [];
  const seenCustomIds = new Set();

  if (Array.isArray(stored?.customTiles)) {
    for (const rawTile of stored.customTiles) {
      const tile = normalizeCustomTile(rawTile);
      if (getCoreTileMap().has(tile.id) || seenCustomIds.has(tile.id)) continue;
      customTiles.push(tile);
      seenCustomIds.add(tile.id);
    }
  }

  const tileMap = getCoreTileMap();
  customTiles.forEach((tile) => tileMap.set(tile.id, tile));

  const fallbackLayout = defaultHomeLayout();
  const incomingLayout = Array.isArray(stored?.homeLayout) && stored.homeLayout.length > 0
    ? stored.homeLayout
    : fallbackLayout;

  const homeLayout = [];
  const seenLayoutIds = new Set();
  for (const rawItem of incomingLayout) {
    const tileId = String(rawItem?.tileId || '').trim();
    if (!tileMap.has(tileId) || seenLayoutIds.has(tileId)) continue;
    const tile = tileMap.get(tileId);
    homeLayout.push({
      tileId,
      enabled: rawItem?.enabled !== false,
      size: normalizeTileSize(rawItem?.size, tile.sizeDefault),
    });
    seenLayoutIds.add(tileId);
  }

  // Ensure every known tile exists in layout.
  for (const tile of CORE_TILES) {
    if (seenLayoutIds.has(tile.id)) continue;
    homeLayout.push({
      tileId: tile.id,
      enabled: true,
      size: tile.sizeDefault,
    });
    seenLayoutIds.add(tile.id);
  }

  for (const tile of customTiles) {
    if (seenLayoutIds.has(tile.id)) continue;
    homeLayout.push({
      tileId: tile.id,
      enabled: true,
      size: tile.sizeDefault,
    });
    seenLayoutIds.add(tile.id);
  }

  return {
    version: 1,
    homeLayout,
    customTiles,
  };
}

function normalizeConnection(connection, existingConnection = null) {
  const type = getConnectionTypeMap().has(connection?.type) ? connection.type : 'generic-http';
  const id = slugify(connection?.id || connection?.name || existingConnection?.id || '');
  const safeId = id || `connection-${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    id: safeId,
    name: String(connection?.name || existingConnection?.name || safeId).trim() || safeId,
    type,
    config: {},
    secrets: {},
  };

  if (type === 'ecowitt') {
    base.secrets.applicationKey = String(connection?.secrets?.applicationKey || existingConnection?.secrets?.applicationKey || '').trim();
    base.secrets.apiKey = String(connection?.secrets?.apiKey || existingConnection?.secrets?.apiKey || '').trim();
    base.secrets.mac = String(connection?.secrets?.mac || existingConnection?.secrets?.mac || '').trim();
    return base;
  }

  if (type === 'huum') {
    base.config.baseUrl = String(connection?.config?.baseUrl || existingConnection?.config?.baseUrl || '').trim();
    base.secrets.username = String(connection?.secrets?.username || existingConnection?.secrets?.username || '').trim();
    base.secrets.password = String(connection?.secrets?.password || existingConnection?.secrets?.password || '').trim();
    return base;
  }

  base.config.baseUrl = String(connection?.config?.baseUrl || existingConnection?.config?.baseUrl || '').trim();
  base.config.authType = GENERIC_AUTH_TYPES.includes(connection?.config?.authType) ? connection.config.authType : (existingConnection?.config?.authType || 'none');
  base.config.headerName = String(connection?.config?.headerName || existingConnection?.config?.headerName || '').trim();
  base.config.headers = (connection?.config?.headers && typeof connection.config.headers === 'object' && !Array.isArray(connection.config.headers))
    ? deepClone(connection.config.headers)
    : (existingConnection?.config?.headers ? deepClone(existingConnection.config.headers) : {});
  base.secrets.username = String(connection?.secrets?.username || existingConnection?.secrets?.username || '').trim();
  base.secrets.password = String(connection?.secrets?.password || existingConnection?.secrets?.password || '').trim();
  base.secrets.bearerToken = String(connection?.secrets?.bearerToken || existingConnection?.secrets?.bearerToken || '').trim();
  base.secrets.headerValue = String(connection?.secrets?.headerValue || existingConnection?.secrets?.headerValue || '').trim();
  return base;
}

function normalizeTileConnectionsConfig(stored = {}) {
  const connections = [];
  const seen = new Set();
  const incoming = Array.isArray(stored?.connections) ? stored.connections : [];
  for (const rawConnection of incoming) {
    const normalized = normalizeConnection(rawConnection);
    if (seen.has(normalized.id)) continue;
    connections.push(normalized);
    seen.add(normalized.id);
  }
  return { connections };
}

function materializeHomeLayout(tilesState) {
  const tileMap = getCoreTileMap();
  tilesState.customTiles.forEach((tile) => tileMap.set(tile.id, tile));

  return tilesState.homeLayout
    .map((item) => {
      const tile = tileMap.get(item.tileId);
      if (!tile) return null;
      return {
        tileId: item.tileId,
        enabled: item.enabled !== false,
        size: normalizeTileSize(item.size, tile.sizeDefault),
        tile: deepClone(tile),
      };
    })
    .filter(Boolean);
}

function publicTile(tile) {
  return {
    id: tile.id,
    kind: tile.kind,
    title: tile.title,
    icon: tile.icon,
    mode: tile.mode,
    description: tile.description || '',
    refreshMs: tile.refreshMs,
    sizeDefault: tile.sizeDefault,
    connectionId: tile.connectionId || '',
  };
}

function publicConnection(connection) {
  const maskedSecrets = {};
  Object.entries(connection.secrets || {}).forEach(([key, value]) => {
    if (value) maskedSecrets[key] = maskSecret(value);
  });

  return {
    id: connection.id,
    name: connection.name,
    type: connection.type,
    config: deepClone(connection.config || {}),
    maskedSecrets,
  };
}

function parsePathSegments(pointer) {
  if (!pointer) return [];
  return String(pointer)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getPathValue(source, pointer) {
  if (!pointer) return undefined;
  return parsePathSegments(pointer).reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, source);
}

function ensureHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }
  return url;
}

function resolveConnectionUrl(baseUrl, requestPath) {
  const normalizedBaseUrl = (() => {
    const raw = String(baseUrl || '').trim();
    if (!raw) return raw;
    const url = new URL(raw);
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  })();

  const base = ensureHttpUrl(normalizedBaseUrl);
  const rawPath = String(requestPath || '').trim();
  if (!rawPath) return base;
  if (/^https?:\/\//i.test(rawPath) || rawPath.startsWith('//')) {
    throw new Error('Absolute URLs are not allowed for tile requests');
  }
  const resolved = new URL(rawPath, base);
  if (resolved.origin !== base.origin) {
    throw new Error('Tile requests must stay on the configured connection origin');
  }
  return resolved;
}

function buildConnectionHeaders(connection) {
  const headers = {};
  if (connection?.type === 'huum') {
    const auth = Buffer.from(`${connection.secrets.username}:${connection.secrets.password}`).toString('base64');
    headers.Authorization = `Basic ${auth}`;
    headers['Content-Type'] = 'application/json';
    return headers;
  }

  if (connection?.type === 'generic-http') {
    Object.entries(connection.config?.headers || {}).forEach(([key, value]) => {
      if (key && value !== undefined && value !== null && value !== '') headers[key] = String(value);
    });

    if (connection.config?.authType === 'basic' && connection.secrets.username && connection.secrets.password) {
      const auth = Buffer.from(`${connection.secrets.username}:${connection.secrets.password}`).toString('base64');
      headers.Authorization = `Basic ${auth}`;
    } else if (connection.config?.authType === 'bearer' && connection.secrets.bearerToken) {
      headers.Authorization = `Bearer ${connection.secrets.bearerToken}`;
    } else if (connection.config?.authType === 'header' && connection.config?.headerName && connection.secrets.headerValue) {
      headers[connection.config.headerName] = connection.secrets.headerValue;
    }

    headers.Accept = headers.Accept || 'application/json';
  }

  return headers;
}

async function fetchEcowittData(connection) {
  const url = new URL('https://api.ecowitt.net/api/v3/device/real_time');
  url.searchParams.append('application_key', connection.secrets.applicationKey);
  url.searchParams.append('api_key', connection.secrets.apiKey);
  url.searchParams.append('mac', connection.secrets.mac);
  url.searchParams.append('call_back', 'all');

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`Weather API returned error code: ${payload.code}`);
  }

  const data = payload.data || {};
  return {
    outdoor: {
      temperature: data.outdoor?.temperature?.value,
      feelsLike: data.outdoor?.feels_like?.value,
      humidity: data.outdoor?.humidity?.value,
    },
    wind: {
      speed: data.wind?.wind_speed?.value,
      gust: data.wind?.wind_gust?.value,
      direction: data.wind?.wind_direction?.value,
    },
    pressure: {
      relative: data.pressure?.relative?.value,
    },
    solar: {
      uv: data.solar_and_uvi?.uvi?.value,
      radiation: data.solar_and_uvi?.solar?.value,
    },
    indoor: {
      temperature: data.indoor?.temperature?.value,
      humidity: data.indoor?.humidity?.value,
    },
    rawData: data,
  };
}

function huumStatusText(statusCode) {
  switch (statusCode) {
    case 230: return 'Offline';
    case 231: return 'Heating';
    case 232: return 'Off';
    case 233: return 'In Use (Locked)';
    case 400: return 'Emergency Stop';
    default: return 'Unknown';
  }
}

async function fetchHuumStatus(connection) {
  const url = resolveConnectionUrl(connection.config.baseUrl, './status');
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildConnectionHeaders(connection),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Sauna API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const temperature = data.temperature ? Math.round((Number(data.temperature) * 9) / 5 + 32) : null;
  const targetTemperature = data.targetTemperature ? Math.round((Number(data.targetTemperature) * 9) / 5 + 32) : null;

  const result = {
    status: huumStatusText(data.statusCode),
    statusCode: data.statusCode,
    temperature,
    targetTemperature,
    duration: Number(data.duration || 0),
    door: data.door,
    isHeating: data.statusCode === 231,
    isOffline: data.statusCode === 230,
    isLocked: data.statusCode === 233,
    isEmergency: data.statusCode === 400,
    rawData: data,
  };

  // Detect usage transitions — log start/stop events
  const isActive = result.isHeating || result.isLocked;
  const wasActive = _prevSaunaState !== null && (_prevSaunaState.isHeating || _prevSaunaState.isLocked);
  if (isActive && !wasActive) {
    logSaunaEvent('start', result);
  } else if (!isActive && wasActive) {
    logSaunaEvent('stop', result);
  }
  _prevSaunaState = { isHeating: result.isHeating, isLocked: result.isLocked };

  return result;
}

async function toggleHuumSauna(connection, turnOn, options = {}) {
  const endpoint = turnOn ? './start' : './stop';
  const url = resolveConnectionUrl(connection.config.baseUrl, endpoint);
  const headers = buildConnectionHeaders(connection);
  const body = turnOn
    ? JSON.stringify({
        targetTemperature: ((Number(options.targetTemperature || 190) - 32) * 5) / 9,
        duration: Number(options.duration || 180),
      })
    : null;

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Sauna toggle failed: ${response.status} ${response.statusText}`);
  }

  return response.json().catch(() => ({}));
}

function renderGenericDisplay(tile, payload) {
  const display = tile.config?.display || {};
  return {
    status: stringifyValue(getPathValue(payload, display.statusPath)),
    value: stringifyValue(getPathValue(payload, display.valuePath)),
    subtitle: stringifyValue(getPathValue(payload, display.subtitlePath)),
    metrics: normalizeMetrics(display.metrics).map((metric) => ({
      label: metric.label,
      value: stringifyValue(getPathValue(payload, metric.path)),
    })),
  };
}

function hydrateActionFields(action, rawInput = {}) {
  const values = {};
  action.fields.forEach((field) => {
    let value = rawInput[field.id];
    if (value === undefined || value === null || value === '') {
      value = field.defaultValue;
    }

    if (field.type === 'number') {
      const parsed = Number(value);
      value = Number.isFinite(parsed) ? parsed : Number(field.defaultValue || 0);
    } else if (field.type === 'boolean') {
      value = value === true || value === 'true' || value === '1' || value === 1;
    } else {
      value = String(value ?? '');
    }

    if (field.required && (value === '' || value === undefined || value === null)) {
      throw new Error(`Missing required field: ${field.label}`);
    }

    values[field.id] = value;
  });
  return values;
}

function expandBodyTemplate(template, values) {
  if (Array.isArray(template)) {
    return template.map((item) => expandBodyTemplate(item, values));
  }
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, expandBodyTemplate(value, values)]));
  }
  if (typeof template === 'string' && template.startsWith('$')) {
    return values[template.slice(1)];
  }
  return template;
}

class Home23TileService {
  constructor({ home23Root, logger = console }) {
    this.home23Root = home23Root;
    this.logger = logger;
    this.cache = new Map();
    this.backgroundRefreshTimers = new Map();
    this.backgroundRefreshInFlight = new Set();
    this.startBackgroundRefresh();
  }

  startBackgroundRefresh() {
    this.stopBackgroundRefresh();

    const tiles = this.getTilesState();
    const layout = materializeHomeLayout(tiles).filter((item) => item.enabled !== false);
    for (const item of layout) {
      const tile = item.tile;
      if (!tile || tile.kind !== 'custom') continue;
      if (tile.mode !== 'ecowitt-weather' && tile.mode !== 'huum-sauna') continue;

      const run = async () => {
        if (this.backgroundRefreshInFlight.has(tile.id)) return;
        this.backgroundRefreshInFlight.add(tile.id);
        try {
          await this.getTileData(tile.id);
        } catch (err) {
          this.logger?.warn?.(`[home23-tiles] background refresh failed for ${tile.id}: ${err.message}`);
        } finally {
          this.backgroundRefreshInFlight.delete(tile.id);
        }
      };

      run().catch(() => {});
      const intervalMs = Math.max(15_000, Math.min(tile.refreshMs || 60_000, 15 * 60_000));
      this.backgroundRefreshTimers.set(tile.id, setInterval(() => {
        run().catch(() => {});
      }, intervalMs));
    }
  }

  stopBackgroundRefresh() {
    for (const timer of this.backgroundRefreshTimers.values()) clearInterval(timer);
    this.backgroundRefreshTimers.clear();
  }

  getHomeConfigPath() {
    return path.join(this.home23Root, 'config', 'home.yaml');
  }

  getSecretsPath() {
    return path.join(this.home23Root, 'config', 'secrets.yaml');
  }

  readHomeConfig() {
    return loadYaml(this.getHomeConfigPath());
  }

  readSecrets() {
    return loadYaml(this.getSecretsPath());
  }

  writeHomeConfig(config) {
    saveYaml(this.getHomeConfigPath(), config);
  }

  writeSecrets(config) {
    saveYaml(this.getSecretsPath(), config);
  }

  getTilesState() {
    const homeConfig = this.readHomeConfig();
    return normalizeDashboardTilesConfig(homeConfig.dashboard?.tiles || {});
  }

  getConnectionsState() {
    const secrets = this.readSecrets();
    return normalizeTileConnectionsConfig(secrets.dashboard?.tileConnections || {});
  }

  invalidateTileCache(tileId = null) {
    if (!tileId) {
      this.cache.clear();
      return;
    }
    this.cache.delete(tileId);
  }

  getSettingsTilesPayload() {
    const tiles = this.getTilesState();
    return {
      version: tiles.version,
      homeLayout: materializeHomeLayout(tiles).map((item) => ({
        tileId: item.tileId,
        enabled: item.enabled,
        size: item.size,
        tile: publicTile(item.tile),
      })),
      customTiles: tiles.customTiles.map(publicTile).map((tile, index) => ({
        ...tile,
        config: deepClone(tiles.customTiles[index].config || {}),
      })),
      coreTiles: CORE_TILES.map(publicTile),
      sizeOptions: deepClone(TILE_SIZES),
      templateModes: deepClone(TILE_TEMPLATES),
    };
  }

  saveTilesSettings(input) {
    const nextTiles = normalizeDashboardTilesConfig(input || {});
    const homeConfig = this.readHomeConfig();
    if (!homeConfig.dashboard) homeConfig.dashboard = {};
    homeConfig.dashboard.tiles = nextTiles;
    this.writeHomeConfig(homeConfig);
    this.invalidateTileCache();
    this.startBackgroundRefresh();
    return nextTiles;
  }

  getSettingsConnectionsPayload() {
    const state = this.getConnectionsState();
    return {
      connections: state.connections.map(publicConnection),
      connectionTypes: deepClone(CONNECTION_TYPES),
      authTypes: deepClone(GENERIC_AUTH_TYPES),
    };
  }

  saveConnectionsSettings(input) {
    const currentState = this.getConnectionsState();
    const existingMap = new Map(currentState.connections.map((connection) => [connection.id, connection]));
    const rawConnections = Array.isArray(input?.connections) ? input.connections : [];
    const nextConnections = [];
    const seenIds = new Set();

    for (const rawConnection of rawConnections) {
      const existing = rawConnection?.id ? existingMap.get(rawConnection.id) : null;
      const normalized = normalizeConnection(rawConnection, existing);
      if (seenIds.has(normalized.id)) continue;
      nextConnections.push(normalized);
      seenIds.add(normalized.id);
    }

    const secrets = this.readSecrets();
    if (!secrets.dashboard) secrets.dashboard = {};
    secrets.dashboard.tileConnections = { connections: nextConnections };
    this.writeSecrets(secrets);
    this.invalidateTileCache();
    this.startBackgroundRefresh();
    return { connections: nextConnections };
  }

  getRuntimeConfig() {
    const tiles = this.getTilesState();
    const layout = materializeHomeLayout(tiles)
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        tileId: item.tileId,
        size: item.size,
        tile: publicTile(item.tile),
      }));

    return {
      version: tiles.version,
      layout,
    };
  }

  resolveTile(tileId) {
    const tiles = this.getTilesState();
    const layout = materializeHomeLayout(tiles);
    const match = layout.find((item) => item.tileId === tileId);
    return match?.tile || null;
  }

  resolveConnection(connectionId) {
    const state = this.getConnectionsState();
    return state.connections.find((connection) => connection.id === connectionId) || null;
  }

  getCachedTileData(tileId, refreshMs) {
    const entry = this.cache.get(tileId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(tileId);
      return null;
    }
    return {
      ...deepClone(entry.payload),
      cache: { hit: true, expiresInMs: Math.max(0, entry.expiresAt - Date.now()), refreshMs },
    };
  }

  setCachedTileData(tileId, refreshMs, payload) {
    this.cache.set(tileId, {
      expiresAt: Date.now() + refreshMs,
      payload: deepClone(payload),
    });
  }

  async getTileData(tileId) {
    const tile = this.resolveTile(tileId);
    if (!tile) throw new Error(`Unknown tile: ${tileId}`);
    if (tile.kind !== 'custom') throw new Error(`Tile "${tileId}" is rendered client-side as a core tile`);

    const cached = this.getCachedTileData(tileId, tile.refreshMs);
    if (cached) return cached;

    const connection = this.resolveConnection(tile.connectionId);
    if (!connection) {
      throw new Error(`Connection "${tile.connectionId}" is not configured`);
    }

    let payload;
    if (tile.mode === 'ecowitt-weather') {
      const weather = await fetchEcowittData(connection);
      const summary = weather?.outdoor?.temperature != null
        ? `${weather.outdoor.temperature}°F${weather.outdoor.humidity != null ? ' · ' + weather.outdoor.humidity + '%RH' : ''}`
        : 'no readings';
      publishTileSensor(tile, 'ecowitt-weather', weather, summary);
      payload = {
        tileId,
        fetchedAt: new Date().toISOString(),
        content: {
          status: 'Weather',
          value: weather.outdoor.temperature != null ? `${weather.outdoor.temperature}°F` : '—',
          subtitle: [
            weather.outdoor.feelsLike != null ? `Feels like ${weather.outdoor.feelsLike}°F` : null,
            weather.outdoor.humidity != null ? `${weather.outdoor.humidity}% humidity` : null,
          ].filter(Boolean).join(' · ') || 'No outdoor readings',
          metrics: [
            { label: 'Wind', value: weather.wind.speed != null ? `${weather.wind.speed} mph` : '—' },
            { label: 'Gust', value: weather.wind.gust != null ? `${weather.wind.gust} mph` : '—' },
            { label: 'Pressure', value: weather.pressure.relative != null ? `${weather.pressure.relative} inHg` : '—' },
            { label: 'UV', value: weather.solar.uv != null ? String(weather.solar.uv) : '—' },
            { label: 'Indoor', value: weather.indoor.temperature != null ? `${weather.indoor.temperature}°F` : '—' },
            { label: 'Indoor Humidity', value: weather.indoor.humidity != null ? `${weather.indoor.humidity}%` : '—' },
          ],
        },
        actions: [],
      };
    } else if (tile.mode === 'huum-sauna') {
      const sauna = await fetchHuumStatus(connection);
      const summary = sauna?.temperature != null
        ? `${sauna.status || '?'} · ${sauna.temperature}°F${sauna.targetTemperature ? ' → ' + sauna.targetTemperature + '°F' : ''}`
        : (sauna?.status || 'unknown');
      publishTileSensor(tile, 'huum-sauna', sauna, summary);
      const startDefaults = tile.config?.startDefaults || {};
      payload = {
        tileId,
        fetchedAt: new Date().toISOString(),
        content: {
          status: sauna.status,
          value: sauna.temperature != null ? `${sauna.temperature}°F` : '—',
          subtitle: [
            sauna.targetTemperature != null ? `Target ${sauna.targetTemperature}°F` : null,
            sauna.duration ? `${sauna.duration} min remaining` : null,
            sauna.door === false ? 'Door open' : sauna.door === true ? 'Door closed' : null,
          ].filter(Boolean).join(' · ') || 'No status details',
          metrics: [
            { label: 'Target', value: sauna.targetTemperature != null ? `${sauna.targetTemperature}°F` : '—' },
            { label: 'Duration', value: sauna.duration ? `${sauna.duration} min` : '—' },
            { label: 'Door', value: sauna.door === false ? 'Open' : sauna.door === true ? 'Closed' : '—' },
            { label: 'Heating', value: sauna.isHeating ? 'Yes' : 'No' },
          ],
        },
        actions: [
          {
            id: 'start',
            label: 'Start',
            method: 'POST',
            confirmationText: 'Start the sauna with these settings?',
            fields: [
              { id: 'targetTemperature', label: 'Target Temperature (F)', type: 'number', defaultValue: startDefaults.targetTemperature ?? 190, required: true },
              { id: 'duration', label: 'Duration (minutes)', type: 'number', defaultValue: startDefaults.duration ?? 180, required: true },
            ],
          },
          {
            id: 'stop',
            label: 'Stop',
            method: 'POST',
            confirmationText: 'Stop the sauna now?',
            fields: [],
          },
        ],
      };
    } else {
      const request = tile.config?.request || {};
      const url = resolveConnectionUrl(connection.config.baseUrl, request.path || '/');
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: buildConnectionHeaders(connection),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`Tile request failed: ${response.status} ${response.statusText}`);
      }
      const raw = await response.json();
      // Generic tile: publish the raw response to the registry. Summary tries
      // to pull a sensible one-liner from common fields; otherwise fall back
      // to JSON size.
      const guessSummary = typeof raw === 'object' && raw
        ? (raw.summary || raw.status || raw.value || raw.title || `${Object.keys(raw).length} fields`)
        : String(raw);
      publishTileSensor(tile, tile.mode || 'generic', raw, String(guessSummary).slice(0, 120));
      payload = {
        tileId,
        fetchedAt: new Date().toISOString(),
        content: renderGenericDisplay(tile, raw),
        actions: deepClone(tile.config?.actions || []).map((action) => ({
          id: action.id,
          label: action.label,
          method: action.method,
          confirmationText: action.confirmationText,
          fields: deepClone(action.fields || []),
        })),
      };
    }

    this.setCachedTileData(tileId, tile.refreshMs, payload);
    return {
      ...deepClone(payload),
      cache: { hit: false, expiresInMs: tile.refreshMs, refreshMs: tile.refreshMs },
    };
  }

  async runTileAction(tileId, actionId, rawInput = {}) {
    const tile = this.resolveTile(tileId);
    if (!tile || tile.kind !== 'custom') {
      throw new Error(`Unknown custom tile: ${tileId}`);
    }

    const connection = this.resolveConnection(tile.connectionId);
    if (!connection) {
      throw new Error(`Connection "${tile.connectionId}" is not configured`);
    }

    let result;
    if (tile.mode === 'huum-sauna') {
      if (actionId === 'start') {
        result = await toggleHuumSauna(connection, true, rawInput);
      } else if (actionId === 'stop') {
        result = await toggleHuumSauna(connection, false);
      } else {
        throw new Error(`Unknown sauna action: ${actionId}`);
      }
    } else if (tile.mode === 'generic-http-json') {
      const action = (tile.config?.actions || []).find((entry) => entry.id === actionId);
      if (!action) throw new Error(`Unknown tile action: ${actionId}`);

      const fieldValues = hydrateActionFields(action, rawInput);
      const url = resolveConnectionUrl(connection.config.baseUrl, action.path);
      const headers = buildConnectionHeaders(connection);
      let body;
      if (action.method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(expandBodyTemplate(action.bodyTemplate || {}, fieldValues));
      }

      const response = await fetch(url.toString(), {
        method: action.method,
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`Tile action failed: ${response.status} ${response.statusText}`);
      }

      result = await response.json().catch(() => ({}));
    } else {
      throw new Error(`Tile "${tileId}" does not expose runtime actions`);
    }

    this.invalidateTileCache(tileId);
    return {
      ok: true,
      tileId,
      actionId,
      result,
    };
  }
}

module.exports = {
  CORE_TILES,
  TILE_SIZES,
  TILE_TEMPLATES,
  CONNECTION_TYPES,
  GENERIC_AUTH_TYPES,
  Home23TileService,
  loadYaml,
  saveYaml,
  normalizeDashboardTilesConfig,
  normalizeTileConnectionsConfig,
  materializeHomeLayout,
};
