const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const zlib = require('zlib');
const gunzip = promisify(zlib.gunzip);
const dotenv = require('dotenv');
const multer = require('multer');

const { RunManager } = require('../launcher/run-manager');
const { ConfigGenerator } = require('../launcher/config-generator');
const { ProcessManager } = require('../launcher/process-manager');
const { BrainQueryEngine } = require('../lib/brain-query-engine');
const {
  loadConfigurationSync,
  getDatabaseUrl,
  getConfigDir,
  getConfigPath,
  getDatabasePath
} = require('../lib/config-loader-sync');
const {
  loadConfigSafe,
  saveConfig,
  getDefaultConfig
} = require('../lib/config-manager');
const {
  getDefaultRegistry,
  resetDefaultRegistry,
  getPlatform
} = require('./providers');
const {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  storeToken,
  clearToken,
  getOAuthStatus,
  importFromClaudeCLI
} = require('./services/anthropic-oauth');
const {
  sanitizeRunName,
  parseReferenceRunsPaths,
  listBrains,
  resolveBrainBySelector,
  importReferenceBrain,
  ensureUniqueRunName
} = require('./lib/brain-registry');
const {
  createBrainsRouter
} = require('./lib/brains-router');
const {
  repairAllRunMetadata
} = require('./lib/run-metadata-repair');
const {
  getModelCatalogPath,
  loadModelCatalogSync,
  saveModelCatalogSync,
  listCatalogModels,
  inferProviderFromModel,
  getCatalogDefaults,
  inferModelKind
} = require('./config/model-catalog');
const {
  normalizeExecutionMode
} = require('../lib/execution-mode');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'engine');
const LOCAL_RUNS_PATH = path.join(ROOT, 'runs');
const RUNTIME_PATH = path.join(ROOT, 'runtime');
const PUBLIC_DIR = path.join(ROOT, 'public');

function applyAnthropicOAuthMode() {
  process.env.ANTHROPIC_OAUTH_ONLY = 'true';
  process.env.FORCE_ANTHROPIC_OAUTH = 'true';
}

dotenv.config({ path: path.join(ROOT, '.env') });
process.env.COSMO23_HOME = getConfigDir();
process.env.COSMO23_CONFIG_PATH = getConfigPath();
const initialConfig = loadConfigurationSync({ projectRoot: ROOT, applyToEnv: true, silent: true });
applyAnthropicOAuthMode();
process.env.DATABASE_URL = process.env.DATABASE_URL || getDatabaseUrl();

const PORT = Number.parseInt(process.env.COSMO23_PORT || process.env.PORT || '43110', 10);
const WS_PORT = Number.parseInt(
  process.env.COSMO23_WS_PORT || process.env.WS_PORT || process.env.REALTIME_PORT || '43140',
  10
);
const MCP_HTTP_PORT = Number.parseInt(
  process.env.COSMO23_MCP_HTTP_PORT || process.env.MCP_HTTP_PORT || '43147',
  10
);
const DASHBOARD_PORT = Number.parseInt(
  process.env.COSMO23_DASHBOARD_PORT || process.env.DASHBOARD_PORT || '43144',
  10
);

process.env.COSMO23_PORT = process.env.COSMO23_PORT || String(PORT);
process.env.COSMO23_WS_PORT = process.env.COSMO23_WS_PORT || String(WS_PORT);
process.env.COSMO23_MCP_HTTP_PORT = process.env.COSMO23_MCP_HTTP_PORT || String(MCP_HTTP_PORT);
process.env.COSMO23_DASHBOARD_PORT = process.env.COSMO23_DASHBOARD_PORT || String(DASHBOARD_PORT);
process.env.PORT = process.env.PORT || String(PORT);
process.env.WS_PORT = process.env.WS_PORT || String(WS_PORT);
process.env.REALTIME_PORT = process.env.REALTIME_PORT || String(WS_PORT);
process.env.MCP_HTTP_PORT = process.env.MCP_HTTP_PORT || String(MCP_HTTP_PORT);
process.env.MCP_PORT = process.env.MCP_PORT || String(MCP_HTTP_PORT);
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || String(DASHBOARD_PORT);
process.env.COSMO_DASHBOARD_PORT = process.env.COSMO_DASHBOARD_PORT || String(DASHBOARD_PORT);

const app = express();
const runManager = new RunManager(LOCAL_RUNS_PATH, console, ROOT);
const configGenerator = new ConfigGenerator(ROOT, console);
const processManager = new ProcessManager(ENGINE_DIR, console);
const queryEngineCache = new Map();
const oauthPkceStateStore = new Map();

let activeContext = null;
let isLaunching = false;

processManager.on('cosmo-exit', ({ code, signal }) => {
  if (activeContext) {
    const runName = activeContext.runName;
    activeContext = null;
    processManager.recordLog('Launcher', 'info',
      `Run "${runName}" ended (code: ${code}, signal: ${signal || 'none'}) — cleared activeContext`);
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function getReferenceRunsPaths() {
  const envPaths = process.env.COSMO_REFERENCE_RUNS_PATHS || process.env.COSMO_REFERENCE_RUNS_PATH || '';

  let configDirs = [];
  try {
    const cosmoConfig = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    configDirs = cosmoConfig?.features?.brains?.directories || [];
  } catch { /* no config */ }

  const combinedRaw = [envPaths, ...configDirs].filter(Boolean).join(',');
  return parseReferenceRunsPaths(combinedRaw, ROOT, LOCAL_RUNS_PATH);
}

function isRunLocal(runPath) {
  const relativePath = path.relative(LOCAL_RUNS_PATH, runPath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function maskSecret(secret) {
  if (!secret || typeof secret !== 'string') {
    return null;
  }
  if (secret.length <= 8) {
    return '***';
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function getWsUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto === 'https' || req.secure ? 'wss' : 'ws';
  return `${protocol}://${req.hostname || 'localhost'}:${WS_PORT}`;
}

async function readSetupConfig() {
  return (await loadConfigSafe()) || getDefaultConfig();
}

function summarizeSetup(config) {
  return {
    configDir: getConfigDir(),
    configPath: getConfigPath(),
    databasePath: getDatabasePath(),
    exists: fs.existsSync(getConfigPath()),
    referenceRunsPaths: getReferenceRunsPaths(),
    brainDirectories: config.features?.brains?.directories || [],
    providers: {
      openai: {
        enabled: !!config.providers?.openai?.enabled,
        configured: !!config.providers?.openai?.api_key,
        maskedKey: maskSecret(config.providers?.openai?.api_key || '')
      },
      anthropic: {
        enabled: !!config.providers?.anthropic?.enabled,
        oauth: true,
        oauthOnly: true
      },
      xai: {
        enabled: !!config.providers?.xai?.enabled,
        configured: !!config.providers?.xai?.api_key,
        maskedKey: maskSecret(config.providers?.xai?.api_key || '')
      },
      ollama: {
        enabled: config.providers?.ollama?.enabled !== false,
        baseUrl: normalizeOllamaNativeUrl(config.providers?.ollama?.base_url || 'http://localhost:11434')
      },
      'ollama-cloud': {
        enabled: !!config.providers?.['ollama-cloud']?.enabled,
        configured: !!config.providers?.['ollama-cloud']?.api_key,
        maskedKey: maskSecret(config.providers?.['ollama-cloud']?.api_key || '')
      },
      'openai-codex': {
        enabled: !!config.providers?.['openai-codex']?.enabled,
        configured: false // OAuth status checked separately
      }
    },
    security: {
      hasEncryptionKey: !!config.security?.encryption_key
    }
  };
}

function mergeSecret(existingValue, incomingValue) {
  if (incomingValue === undefined || incomingValue === null) {
    return existingValue || '';
  }
  const trimmed = String(incomingValue).trim();
  if (!trimmed) {
    return existingValue || '';
  }
  return trimmed;
}

function normalizeOllamaNativeUrl(baseUrl) {
  return String(baseUrl || 'http://localhost:11434').replace(/\/v1\/?$/i, '');
}

function normalizeLocalLlmApiUrl(baseUrl) {
  const trimmed = String(baseUrl || 'http://localhost:11434').trim();
  return /\/v1\/?$/i.test(trimmed) ? trimmed : `${trimmed.replace(/\/+$/, '')}/v1`;
}

function isLocalProvider(providerId) {
  return providerId === 'ollama' || providerId === 'local';
}

function normalizeLaunchProvider(providerId) {
  if (providerId === 'ollama-cloud') return 'ollama-cloud';
  return isLocalProvider(providerId) ? 'local' : providerId;
}

function pickFirstModelByProvider(providerId, candidates, fallback) {
  for (const candidate of candidates) {
    if (candidate?.provider === providerId && candidate?.model) {
      return candidate.model;
    }
  }
  return fallback;
}

async function buildProvidersModelsPayload() {
  const registry = await getDefaultRegistry();
  const catalog = loadModelCatalogSync();
  const defaults = getCatalogDefaults(catalog);
  let models = listCatalogModels(catalog);

  const ollamaProvider = registry.getProviderById('ollama');
  if (ollamaProvider) {
    try {
      const ollamaHealth = await ollamaProvider.healthCheck();
      if (ollamaHealth.healthy) {
        const installedModels = await ollamaProvider.listModels();
        models = models.filter(model => model.provider !== 'ollama');
        for (const modelId of installedModels) {
          // Skip cloud-tagged models — they belong in Ollama Cloud, not local
          if (modelId.endsWith(':cloud') || modelId.includes('-cloud')) continue;
          models.push({
            id: modelId,
            provider: 'ollama',
            providerLabel: 'Ollama (Local)',
            label: modelId,
            kind: inferModelKind(modelId),
            source: 'installed'
          });
        }
      }
    } catch {
      // Ignore dynamic local listing failures and fall back to catalog-only models.
    }
  }

  // Ollama Cloud — use curated catalog list (not dynamic discovery which returns 100s of models)
  // The catalog in model-catalog.js has the vetted cloud-tagged models with proper labels.

  // OpenAI Codex — dynamic model discovery with seed list fallback
  const codexProvider = registry.getProviderById('openai-codex');
  if (codexProvider) {
    const CODEX_DISCOVERY_TTL = 5 * 60 * 1000; // 5 minutes
    let codexModels = null;

    // Check cached discovery
    if (registry._codexDiscoveredModels && registry._codexDiscoveryTime &&
        (Date.now() - registry._codexDiscoveryTime) < CODEX_DISCOVERY_TTL) {
      codexModels = registry._codexDiscoveredModels;
    } else {
      // Try fresh discovery
      try {
        if (codexProvider.listModels) {
          const discovered = await codexProvider.listModels();
          if (discovered && discovered.length > 0) {
            codexModels = discovered;
            registry._codexDiscoveredModels = discovered;
            registry._codexDiscoveryTime = Date.now();
          }
        }
      } catch {
        // Silent fallback to seed list
      }
    }

    // Fall back to seed list from catalog
    if (!codexModels) {
      const codexCatalog = catalog?.providers?.['openai-codex']?.models;
      if (codexCatalog) {
        codexModels = codexCatalog.map(m => m.id);
      }
    }

    if (codexModels && codexModels.length > 0) {
      // Remove any catalog-sourced openai-codex entries first
      models = models.filter(m => m.provider !== 'openai-codex');
      for (const modelId of codexModels) {
        models.push({
          id: modelId,
          provider: 'openai-codex',
          providerLabel: 'OpenAI Codex',
          label: modelId,
          kind: 'chat',
          source: 'codex'
        });
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const model of models) {
    if (!model?.id || seen.has(`${model.provider}:${model.id}`)) {
      continue;
    }
    seen.add(`${model.provider}:${model.id}`);
    deduped.push({
      id: model.id,
      provider: model.provider,
      providerLabel: model.providerLabel || model.provider,
      label: model.label || model.id,
      kind: model.kind || inferModelKind(model.id),
      source: model.source || 'catalog'
    });
  }

  return {
    success: true,
    models: deduped,
    defaults,
    catalogPath: getModelCatalogPath(),
    providerCount: registry.getProviderIds().length,
    platform: getPlatform()
  };
}

async function applyStoredConfig() {
  process.env.COSMO23_HOME = getConfigDir();
  process.env.COSMO23_CONFIG_PATH = getConfigPath();
  const loadedConfig = loadConfigurationSync({ projectRoot: ROOT, applyToEnv: true, silent: true });
  applyAnthropicOAuthMode();
  process.env.DATABASE_URL = getDatabaseUrl();
  resetDefaultRegistry();
}

function serializeLaunchSettings(payload, setupConfig) {
  const catalog = loadModelCatalogSync();
  const defaults = getCatalogDefaults(catalog);
  const explorationMode = String(payload.explorationMode || 'guided').trim() || 'guided';
  const executionModeInfo = normalizeExecutionMode(explorationMode, payload.executionMode);
  const ollamaBaseUrl = normalizeLocalLlmApiUrl(setupConfig?.providers?.ollama?.base_url || 'http://localhost:11434');
  // LM Studio removed from web UI — use ollamaBaseUrl for local LLM
  const selectedModels = {
    primary: String(
      payload.primaryModel
      || payload.openaiDefaultModel
      || payload.anthropicDefaultModel
      || payload.localLlmDefaultModel
      || defaults.launch.primary
    ).trim(),
    fast: String(
      payload.fastModel
      || payload.localLlmFastModel
      || payload.openaiFastModel
      || payload.anthropicDefaultModel
      || defaults.launch.fast
    ).trim(),
    strategic: String(
      payload.strategicModel
      || payload.openaiStrategicModel
      || payload.anthropicStrategicModel
      || payload.localLlmDefaultModel
      || defaults.launch.strategic
    ).trim()
  };

  const assignments = [
    { role: 'primary', model: selectedModels.primary, provider: normalizeLaunchProvider(payload.primaryProvider || inferProviderFromModel(selectedModels.primary, catalog) || 'openai') },
    { role: 'fast', model: selectedModels.fast, provider: normalizeLaunchProvider(payload.fastProvider || inferProviderFromModel(selectedModels.fast, catalog) || 'openai') },
    { role: 'strategic', model: selectedModels.strategic, provider: normalizeLaunchProvider(payload.strategicProvider || inferProviderFromModel(selectedModels.strategic, catalog) || 'openai') }
  ];

  const usesOllamaCloud = assignments.some(item => item.provider === 'ollama-cloud');
  const usesLocal = assignments.some(item => item.provider === 'local') || parseBoolean(payload.enableLocalLlm, false);
  const usesAnthropic = assignments.some(item => item.provider === 'anthropic') || parseBoolean(payload.enableAnthropic, false);
  const usesXai = assignments.some(item => item.provider === 'xai');
  const usesOpenAI = assignments.some(item => item.provider === 'openai');
  const usesCodex = assignments.some(item => item.provider === 'openai-codex');

  const localPrimaryModel = pickFirstModelByProvider('local', assignments, null)
    || String(payload.localLlmDefaultModel || defaults.local.primary).trim();
  const localFastModel = (assignments.find(item => item.provider === 'local' && item.role === 'fast') || {}).model
    || String(payload.localLlmFastModel || defaults.local.fast).trim();
  const anthropicDefaultModel = (assignments.find(item => item.provider === 'anthropic' && item.role !== 'strategic') || {}).model
    || String(payload.anthropicDefaultModel || 'claude-sonnet-4-6').trim();
  const anthropicStrategicModel = (assignments.find(item => item.provider === 'anthropic' && item.role === 'strategic') || {}).model
    || String(payload.anthropicStrategicModel || anthropicDefaultModel).trim();
  const xaiDefaultModel = (assignments.find(item => item.provider === 'xai' && item.role !== 'strategic') || {}).model
    || String(payload.xaiDefaultModel || 'grok-4-1-fast-reasoning').trim();
  const xaiStrategicModel = (assignments.find(item => item.provider === 'xai' && item.role === 'strategic') || {}).model
    || String(payload.xaiStrategicModel || xaiDefaultModel).trim();

  return {
    exploration_mode: explorationMode,
    domain: payload.topic || '',
    context: payload.context || '',
    execution_mode: executionModeInfo.persistedMode,
    requested_execution_mode: executionModeInfo.requestedMode,
    effective_execution_mode: executionModeInfo.effectiveMode,
    depth: payload.analysisDepth || payload.depth || 'normal',
    max_cycles: String(payload.cycles || 100),
    max_runtime_minutes: Number.parseInt(payload.maxRuntimeMinutes || 0, 10),
    silent_planning: parseBoolean(payload.silentPlanning, false),
    enable_web_search: parseBoolean(payload.enableWebSearch, true),
    enable_sleep: parseBoolean(payload.enableSleep, true),
    enable_coding_agents: parseBoolean(payload.enableCodingAgents, true),
    enable_introspection: parseBoolean(payload.enableIntrospection, true),
    enable_agent_routing: parseBoolean(payload.enableAgentRouting, true),
    enable_recursive_mode: parseBoolean(payload.enableRecursiveMode, true),
    enable_memory_governance: parseBoolean(payload.enableMemoryGovernance, true),
    enable_frontier: parseBoolean(payload.enableFrontier, true),
    enable_capabilities: true,
    frontier_mode: payload.frontierMode || 'observe',
    review_period: Number.parseInt(payload.reviewPeriod || 20, 10),
    max_concurrent: Number.parseInt(payload.maxConcurrent || 4, 10),
    file_access_paths: payload.fileAccessPaths || 'runtime/outputs/, runtime/exports/',
    enable_ide_first: parseBoolean(payload.enableIDEFirst, false),
    enable_direct_action: parseBoolean(payload.enableDirectAction, false),
    enable_stabilization: parseBoolean(payload.enableStabilization, false),
    enable_consolidation_mode: parseBoolean(payload.enableConsolidationMode, false),
    consolidation_cycles: Number.parseInt(payload.consolidationCycles || 50, 10),
    consolidation_dreams_per_cycle: Number.parseInt(payload.consolidationDreamsPerCycle || 10, 10),
    enable_experimental: parseBoolean(payload.enableExperimental, false),
    enable_github_mcp: parseBoolean(payload.enableGithubMcp, false),
    github_token: payload.githubToken || '',
    primary_provider: assignments.find(item => item.role === 'primary').provider,
    primary_model: selectedModels.primary,
    fast_provider: assignments.find(item => item.role === 'fast').provider,
    fast_model: selectedModels.fast,
    strategic_provider: assignments.find(item => item.role === 'strategic').provider,
    strategic_model: selectedModels.strategic,
    enable_local_llm: usesLocal,
    enable_ollama_cloud: usesOllamaCloud,
    ollama_cloud_api_key: setupConfig?.providers?.['ollama-cloud']?.api_key || process.env.OLLAMA_CLOUD_API_KEY || '',
    local_llm_base_url: payload.localLlmBaseUrl || ollamaBaseUrl,
    local_llm_default_model: localPrimaryModel,
    local_llm_fast_model: localFastModel,
    searxng_url: payload.searxngUrl || process.env.SEARXNG_URL || '',
    enable_anthropic: usesAnthropic,
    anthropic_default_model: anthropicDefaultModel,
    anthropic_strategic_model: anthropicStrategicModel,
    enable_openai: usesOpenAI,
    enable_openai_codex: usesCodex,
    enable_xai: usesXai,
    xai_default_model: xaiDefaultModel,
    xai_strategic_model: xaiStrategicModel
  };
}

async function writeRuntimeMetadata(runPath, payload, launchSettings) {
  const researchDomain = payload.topic || '';
  const researchContext = payload.context || '';
  const metadata = {
    topic: payload.topic || '',
    domain: researchDomain,
    researchDomain,
    context: payload.context || '',
    researchContext,
    runName: path.basename(runPath),
    explorationMode: launchSettings.exploration_mode,
    executionMode: launchSettings.execution_mode,
    requestedExecutionMode: launchSettings.requested_execution_mode,
    effectiveExecutionMode: launchSettings.effective_execution_mode,
    analysisDepth: launchSettings.depth,
    cycles: Number.parseInt(launchSettings.max_cycles, 10),
    maxRuntimeMinutes: launchSettings.max_runtime_minutes,
    enableWebSearch: launchSettings.enable_web_search,
    enableSleep: launchSettings.enable_sleep,
    enableCodingAgents: launchSettings.enable_coding_agents,
    enableIntrospection: launchSettings.enable_introspection,
    enableAgentRouting: launchSettings.enable_agent_routing,
    enableRecursiveMode: launchSettings.enable_recursive_mode,
    enableMemoryGovernance: launchSettings.enable_memory_governance,
    enableFrontier: launchSettings.enable_frontier,
    frontierMode: launchSettings.frontier_mode,
    enableIDEFirst: launchSettings.enable_ide_first,
    enableDirectAction: launchSettings.enable_direct_action,
    enableStabilization: launchSettings.enable_stabilization,
    enableConsolidationMode: launchSettings.enable_consolidation_mode,
    enableExperimental: launchSettings.enable_experimental,
    enableLocalLlm: launchSettings.enable_local_llm,
    primaryProvider: launchSettings.primary_provider,
    primaryModel: launchSettings.primary_model,
    fastProvider: launchSettings.fast_provider,
    fastModel: launchSettings.fast_model,
    strategicProvider: launchSettings.strategic_provider,
    strategicModel: launchSettings.strategic_model,
    localLlmBaseUrl: launchSettings.local_llm_base_url,
    localLlmDefaultModel: launchSettings.local_llm_default_model,
    localLlmFastModel: launchSettings.local_llm_fast_model,
    enableOpenAI: launchSettings.enable_openai,
    enableAnthropic: launchSettings.enable_anthropic,
    anthropicDefaultModel: launchSettings.anthropic_default_model,
    anthropicStrategicModel: launchSettings.anthropic_strategic_model,
    enableXAI: launchSettings.enable_xai,
    xaiDefaultModel: launchSettings.xai_default_model,
    xaiStrategicModel: launchSettings.xai_strategic_model,
    savedAt: new Date().toISOString()
  };

  await fsp.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

async function ensureRuntimeLink(runName) {
  await runManager.linkRuntime(runName, RUNTIME_PATH);
}

async function ensureLocalBrainForLaunch(payload) {
  if (payload.brainId) {
    const selected = await resolveBrainBySelector(payload.brainId, {
      localRunsPath: LOCAL_RUNS_PATH,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: activeContext?.runPath || null
    });

    if (!selected) {
      const error = new Error('Brain not found');
      error.statusCode = 404;
      throw error;
    }

    if (selected.sourceType === 'reference') {
      return importReferenceBrain(selected, LOCAL_RUNS_PATH);
    }

    return selected;
  }

  const baseName = sanitizeRunName(payload.runName || payload.topic || 'cosmo');
  const runName = await ensureUniqueRunName(baseName, LOCAL_RUNS_PATH);
  const created = await runManager.createRun(runName);
  if (!created.success) {
    const error = new Error(created.error || 'Failed to create run');
    error.statusCode = 500;
    throw error;
  }

  return {
    id: crypto.createHash('sha1').update(created.path).digest('hex').slice(0, 16),
    routeKey: crypto.createHash('sha1').update(created.path).digest('hex').slice(0, 16),
    name: runName,
    path: created.path,
    sourceType: 'local',
    sourceLabel: 'Local',
    topic: payload.topic || '',
    hasState: false,
    cycleCount: 0
  };
}

async function getQueryEngine(brainPath) {
  if (!queryEngineCache.has(brainPath)) {
    queryEngineCache.set(brainPath, new BrainQueryEngine(brainPath, process.env.OPENAI_API_KEY));
  }
  return queryEngineCache.get(brainPath);
}

async function startProcessesForRun(runPath) {
  process.env.COSMO_RUNTIME_PATH = runPath;
  process.env.COSMO_RUNS_PATH = LOCAL_RUNS_PATH;
  process.env.COSMO23_WS_PORT = String(WS_PORT);
  process.env.COSMO23_MCP_HTTP_PORT = String(MCP_HTTP_PORT);
  process.env.COSMO23_DASHBOARD_PORT = String(DASHBOARD_PORT);
  process.env.REALTIME_PORT = String(WS_PORT);
  process.env.MCP_HTTP_PORT = String(MCP_HTTP_PORT);
  process.env.MCP_PORT = String(MCP_HTTP_PORT);
  process.env.DASHBOARD_PORT = String(DASHBOARD_PORT);
  process.env.COSMO_DASHBOARD_PORT = String(DASHBOARD_PORT);

  await processManager.startMCPServer(MCP_HTTP_PORT);
  await processManager.startMainDashboard(DASHBOARD_PORT);
  await processManager.startCOSMO();
}

async function launchResearch(payload, req) {
  if (activeContext || isLaunching) {
    const error = new Error(`COSMO is already running${activeContext ? ` ${activeContext.runName}` : ''}`);
    error.statusCode = 409;
    throw error;
  }
  isLaunching = true;

  try {
    const brain = await ensureLocalBrainForLaunch(payload);
    const setupConfig = await readSetupConfig();
    const launchSettings = serializeLaunchSettings(payload, setupConfig);
    processManager.clearLogs();
    processManager.recordLog('Launcher', 'info', `Preparing run ${brain.name}`);

    await ensureRuntimeLink(brain.name);
    process.env.COSMO_RUNTIME_PATH = path.join(LOCAL_RUNS_PATH, brain.name);
    await configGenerator.writeConfig(launchSettings);
    await configGenerator.writeMetadata(brain.path, launchSettings, false);
    await writeRuntimeMetadata(brain.path, payload, launchSettings);
    processManager.recordLog('Launcher', 'info', `Runtime linked to ${brain.path}`);
    await startProcessesForRun(brain.path);

    activeContext = {
      runName: brain.name,
      runPath: brain.path,
      brainId: brain.id || brain.routeKey,
      topic: payload.topic || brain.topic || brain.name,
      explorationMode: launchSettings.exploration_mode,
      executionMode: launchSettings.execution_mode,
      effectiveExecutionMode: launchSettings.effective_execution_mode,
      startedAt: new Date().toISOString(),
      wsUrl: getWsUrl(req)
    };
    processManager.recordLog('Launcher', 'info', `Run ${brain.name} started`);

    return {
      success: true,
      runName: brain.name,
      brainId: activeContext.brainId,
      brainPath: brain.path,
      brainSourceType: brain.sourceType,
      isContinuation: brain.hasState,
      cycles: Number.parseInt(launchSettings.max_cycles, 10),
      executionMode: launchSettings.execution_mode,
      effectiveExecutionMode: launchSettings.effective_execution_mode,
      wsUrl: activeContext.wsUrl,
      dashboardUrl: `http://localhost:${DASHBOARD_PORT}`
    };
  } finally {
    isLaunching = false;
  }
}

function pruneOAuthFlows() {
  const now = Date.now();
  const maxAgeMs = 10 * 60 * 1000;
  for (const [state, value] of oauthPkceStateStore.entries()) {
    if (!value || now - value.createdAt > maxAgeMs) {
      oauthPkceStateStore.delete(state);
    }
  }
}

function extractCallbackParams(input) {
  const parsed = new URL(input);
  return {
    code: parsed.searchParams.get('code'),
    state: parsed.searchParams.get('state')
  };
}

app.get('/api/health', async (_req, res) => {
  res.json({
    success: true,
    name: 'cosmo-2.3',
    running: !!activeContext
  });
});

app.get('/api/setup/status', async (_req, res) => {
  const config = await readSetupConfig();
  res.json({
    success: true,
    setup: summarizeSetup(config)
  });
});

app.post('/api/setup/bootstrap', async (req, res) => {
  const currentConfig = await readSetupConfig();
  const nextConfig = JSON.parse(JSON.stringify(currentConfig));

  nextConfig.version = nextConfig.version || '2.3.0';
  nextConfig.server.http_port = Number.parseInt(req.body.httpPort || PORT, 10);
  nextConfig.security.workspace_root = ROOT;
  nextConfig.security.encryption_key = nextConfig.security.encryption_key || crypto.randomBytes(32).toString('hex');

  nextConfig.providers.openai.enabled = parseBoolean(req.body.enableOpenAI, nextConfig.providers.openai.enabled || false);
  nextConfig.providers.openai.api_key = mergeSecret(nextConfig.providers.openai.api_key, req.body.openaiApiKey);
  if (nextConfig.providers.openai.api_key) {
    nextConfig.providers.openai.enabled = true;
  }

  nextConfig.providers.anthropic.enabled = parseBoolean(req.body.enableAnthropic, nextConfig.providers.anthropic.enabled || false);
  nextConfig.providers.anthropic.oauth = true;
  // Enable if OAuth is configured (checked via DB, not api_key)
  const anthropicOAuthState = await getOAuthStatus().catch(() => ({ configured: false }));
  if (anthropicOAuthState.configured) {
    nextConfig.providers.anthropic.enabled = true;
  }

  nextConfig.providers.xai.enabled = parseBoolean(req.body.enableXAI, nextConfig.providers.xai.enabled || false);
  nextConfig.providers.xai.api_key = mergeSecret(nextConfig.providers.xai.api_key, req.body.xaiApiKey);
  if (nextConfig.providers.xai.api_key) {
    nextConfig.providers.xai.enabled = true;
  }

  if (!nextConfig.providers['ollama-cloud']) { nextConfig.providers['ollama-cloud'] = {}; }
  nextConfig.providers['ollama-cloud'].enabled = parseBoolean(req.body.enableOllamaCloud, nextConfig.providers['ollama-cloud'].enabled || false);
  nextConfig.providers['ollama-cloud'].api_key = mergeSecret(nextConfig.providers['ollama-cloud'].api_key, req.body.ollamaCloudApiKey);
  if (nextConfig.providers['ollama-cloud'].api_key) {
    nextConfig.providers['ollama-cloud'].enabled = true;
  }

  if (!nextConfig.providers['openai-codex']) { nextConfig.providers['openai-codex'] = {}; }
  nextConfig.providers['openai-codex'].enabled = parseBoolean(req.body.enableOpenAICodex, nextConfig.providers['openai-codex'].enabled || false);

  nextConfig.providers.ollama.enabled = parseBoolean(req.body.enableOllama, nextConfig.providers.ollama.enabled !== false);
  nextConfig.providers.ollama.base_url = normalizeOllamaNativeUrl(req.body.ollamaBaseUrl || nextConfig.providers.ollama.base_url || 'http://localhost:11434');
  nextConfig.providers.ollama.auto_detect = parseBoolean(req.body.ollamaAutoDetect, nextConfig.providers.ollama.auto_detect !== false);

  process.env.ENCRYPTION_KEY = nextConfig.security.encryption_key;
  // Brain directories
  if (Array.isArray(req.body.brainDirectories)) {
    if (!nextConfig.features) nextConfig.features = {};
    if (!nextConfig.features.brains) nextConfig.features.brains = {};
    nextConfig.features.brains.enabled = true;
    nextConfig.features.brains.directories = req.body.brainDirectories.filter(d => typeof d === 'string' && d.trim());
  }

  await saveConfig(nextConfig);
  process.env.OPENAI_API_KEY = nextConfig.providers.openai.api_key || '';
  process.env.XAI_API_KEY = nextConfig.providers.xai.api_key || '';
  process.env.OLLAMA_CLOUD_API_KEY = nextConfig.providers['ollama-cloud']?.api_key || '';
  await applyStoredConfig();

  res.json({
    success: true,
    setup: summarizeSetup(nextConfig)
  });
});

app.get('/api/providers/models', async (_req, res) => {
  try {
    res.json(await buildProvidersModelsPayload());
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/models/catalog', async (_req, res) => {
  try {
    const payload = await buildProvidersModelsPayload();
    res.json({
      success: true,
      catalogPath: payload.catalogPath,
      catalog: loadModelCatalogSync(),
      models: payload.models,
      defaults: payload.defaults
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/models/catalog', async (req, res) => {
  try {
    const nextCatalog = saveModelCatalogSync(req.body?.catalog || req.body || {});
    resetDefaultRegistry();
    res.json({
      success: true,
      catalogPath: getModelCatalogPath(),
      catalog: nextCatalog
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/providers/status', async (_req, res) => {
  try {
    const registry = await getDefaultRegistry();
    const providers = await registry.healthCheck();
    res.json({
      success: true,
      providers,
      capabilities: registry.getCapabilities(),
      providerIds: registry.getProviderIds()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/providers/capabilities', async (_req, res) => {
  try {
    const registry = await getDefaultRegistry();
    res.json({
      success: true,
      capabilities: registry.getCapabilities()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function beginAnthropicOAuth(_req, res) {
  const { authUrl, verifier } = getAuthorizationUrl();
  const state = new URL(authUrl).searchParams.get('state');
  pruneOAuthFlows();
  oauthPkceStateStore.set(state, {
    verifier,
    createdAt: Date.now()
  });

  res.json({
    success: true,
    authUrl,
    expiresInSeconds: 600
  });
}

app.get('/api/oauth/anthropic/start', beginAnthropicOAuth);
app.post('/api/oauth/anthropic/start', beginAnthropicOAuth);

async function completeAnthropicOAuth(req, res) {
  try {
    let { code, state } = req.method === 'GET' ? req.query : req.body;
    if ((!code || !state) && (req.query.callbackUrl || req.body?.callbackUrl)) {
      const parsed = extractCallbackParams(req.query.callbackUrl || req.body.callbackUrl);
      code = parsed.code;
      state = parsed.state;
    }

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        error: 'Missing OAuth code/state'
      });
    }

    pruneOAuthFlows();
    const flow = oauthPkceStateStore.get(state);
    if (!flow?.verifier) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired OAuth flow. Start a new OAuth session.'
      });
    }

    oauthPkceStateStore.delete(state);
    const tokens = await exchangeCodeForTokens(code, state, flow.verifier);
    await storeToken(tokens.accessToken, tokens.expiresAt, tokens.refreshToken);
    resetDefaultRegistry();

    res.json({
      success: true,
      expiresAt: new Date(tokens.expiresAt).toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

app.get('/api/oauth/anthropic/callback', completeAnthropicOAuth);
app.post('/api/oauth/anthropic/exchange', completeAnthropicOAuth);

app.get('/api/oauth/anthropic/status', async (_req, res) => {
  try {
    const oauth = await getOAuthStatus();
    res.json({
      success: true,
      oauth,
      ...oauth,
      oauthOnly: true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/oauth/anthropic/import-cli', async (_req, res) => {
  try {
    const result = await importFromClaudeCLI();
    if (!result.success) {
      return res.status(400).json(result);
    }
    resetDefaultRegistry();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/oauth/anthropic/logout', async (_req, res) => {
  try {
    await clearToken();
    resetDefaultRegistry();
    res.json({
      success: true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// OpenAI Codex OAuth routes
let codexOAuth = null;
try { codexOAuth = require('./services/openai-codex-oauth'); } catch (e) {
  console.warn('[Server] OpenAI Codex OAuth service not available:', e.message);
}

app.post('/api/oauth/openai-codex/start', async (_req, res) => {
  if (!codexOAuth) return res.status(500).json({ success: false, error: 'Codex OAuth service not available' });
  try {
    const result = await codexOAuth.startOAuthFlow();
    if (!result.success) return res.status(400).json(result);
    resetDefaultRegistry();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/oauth/openai-codex/import', async (_req, res) => {
  if (!codexOAuth) return res.status(500).json({ success: false, error: 'Codex OAuth service not available' });
  try {
    const result = await codexOAuth.importFromEvobrew();
    if (!result.success) return res.status(400).json(result);
    resetDefaultRegistry();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/oauth/openai-codex/status', async (_req, res) => {
  if (!codexOAuth) return res.json({ success: true, oauth: { configured: false, source: 'none', valid: false, expiresAt: null } });
  try {
    const oauth = await codexOAuth.getCodexOAuthStatus();
    res.json({ success: true, oauth });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/oauth/openai-codex/logout', async (_req, res) => {
  if (!codexOAuth) return res.status(500).json({ success: false, error: 'Codex OAuth service not available' });
  try {
    await codexOAuth.clearCodexToken();
    resetDefaultRegistry();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Interactive session routes
// ══════════════════════════════════════════════════════════════════════════

let interactiveSession = null;

async function loadInteractiveState(runPath) {
  const candidates = [
    path.join(runPath, 'state.json.gz'),
    path.join(runPath, 'coordinator', 'state.json.gz'),
    path.join(runPath, 'state.json'),
    path.join(runPath, 'coordinator', 'state.json')
  ];

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      if (candidate.endsWith('.gz')) {
        const compressed = await fsp.readFile(candidate);
        const decompressed = await gunzip(compressed);
        return JSON.parse(decompressed.toString());
      }
      return JSON.parse(await fsp.readFile(candidate, 'utf8'));
    } catch {
      // try next candidate
    }
  }

  return {};
}

app.post('/api/interactive/start', async (req, res) => {
  try {
    let sessionRunPath = activeContext?.runPath || null;
    let sessionModel = activeContext?.primaryModel || null;

    if (!sessionRunPath) {
      const requestedBrainId = req.body?.brainId || req.body?.runName || req.body?.name || null;
      const selected = requestedBrainId
        ? await resolveBrainBySelector(requestedBrainId, {
            localRunsPath: LOCAL_RUNS_PATH,
            referenceRunsPaths: getReferenceRunsPaths(),
            activeRunPath: activeContext?.runPath || null
          })
        : null;

      const fallbackBrains = selected ? [selected] : await listBrains({
        localRunsPath: LOCAL_RUNS_PATH,
        referenceRunsPaths: getReferenceRunsPaths(),
        activeRunPath: activeContext?.runPath || null
      });

      const attachTarget = selected || fallbackBrains.find(brain =>
        brain?.name === 'merged-jgscrapes' ||
        String(brain?.path || '').endsWith('/merged-jgscrapes') ||
        (brain?.hasState && (brain?.cycleCount || 0) > 0)
      ) || fallbackBrains.find(brain => brain?.hasState) || fallbackBrains[0];

      if (!attachTarget?.path) {
        return res.status(400).json({ success: false, error: 'No active run or attachable brain found.' });
      }

      sessionRunPath = attachTarget.path;
      sessionModel = attachTarget.primaryModel || attachTarget.metadata?.primaryModel || 'claude-sonnet-4-6';
    }

    // Lazy-load InteractiveSession from engine
    let InteractiveSession;
    try {
      ({ InteractiveSession } = require(path.join(ENGINE_DIR, 'src/interactive/interactive-session')));
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Interactive session module not available: ' + e.message });
    }

    if (interactiveSession?.active) {
      return res.json({ success: true, sessionId: interactiveSession.sessionId, resumed: true });
    }

    // Build a lightweight orchestrator-like context object hydrated from the active run.
    // The engine orchestrator runs in a subprocess — we can't access it directly.
    const hydratedState = await loadInteractiveState(sessionRunPath);

    // Convert arrays to Maps so interactive-session.js can use .size (matches live orchestrator shape)
    const rawNodes = hydratedState.memory?.nodes || [];
    const rawEdges = hydratedState.memory?.edges || [];
    const nodeMap = new Map(rawNodes.map(n => [n.id, n]));
    const edgeMap = new Map(rawEdges.map((e, i) => {
      const key = e.source != null && e.target != null ? `${e.source}->${e.target}` : `edge_${i}`;
      return [key, e];
    }));

    // Load run config.yaml so the session knows the domain/topic
    let runConfig = {};
    try {
      const yaml = require('js-yaml');
      const configYaml = await fsp.readFile(path.join(sessionRunPath, 'config.yaml'), 'utf8');
      runConfig = yaml.load(configYaml) || {};
    } catch { /* no config — use defaults */ }

    const sessionContext = {
      runtimePath: sessionRunPath,
      config: { logsDir: sessionRunPath, ...runConfig },
      cycleCount: hydratedState.cycleCount || 0,
      memory: { nodes: nodeMap, edges: edgeMap },
      goals: hydratedState.goals || { active: [], completed: [] },
      agentExecutor: hydratedState.agentExecutor || null,
      executiveRing: hydratedState.executiveRing || null,
      stateModulator: hydratedState.stateModulator || null,
      coordinator: hydratedState.coordinator || null,
      journal: hydratedState.journal || []
    };

    // Create an LLM client wrapper using the provider registry
    const registry = await getDefaultRegistry();
    const requestedModel = String(req.body?.model || '').trim();
    const model = requestedModel || sessionModel || 'claude-sonnet-4-6';
    const requestedProviderId = req.body?.provider || null;
    const provider = requestedProviderId
      ? registry.getProviderById(requestedProviderId)
      : registry.getProvider(model);
    const llmClient = provider ? {
      createCompletion: async (params) => {
        // Unwrap OpenAI tool format to unified format for provider adapter
        const unifiedTools = (params.tools || []).map(t => {
          if (t.type === 'function' && t.function) {
            return {
              name: t.function.name,
              description: t.function.description,
              parameters: (() => {
                const schema = { ...((t.function.parameters || {})) };
                schema.additionalProperties = false;
                if (schema.properties && typeof schema.properties === 'object') {
                  schema.required = Object.keys(schema.properties);
                } else if (!Array.isArray(schema.required)) {
                  schema.required = [];
                }
                return schema;
              })()
            };
          }
          return {
            ...t,
            parameters: (() => {
              const schema = { ...((t.parameters || {})) };
              schema.additionalProperties = false;
              if (schema.properties && typeof schema.properties === 'object') {
                schema.required = Object.keys(schema.properties);
              } else if (!Array.isArray(schema.required)) {
                schema.required = [];
              }
              return schema;
            })()
          };
        });

        const effectiveProvider = params.provider
          ? registry.getProviderById(params.provider)
          : provider;
        if (!effectiveProvider) {
          throw new Error(`No provider available for ${params.provider || params.model || model}`);
        }
        const response = await effectiveProvider.createMessage({
          model: params.model || model,
          messages: params.messages,
          tools: unifiedTools.length > 0 ? unifiedTools : undefined,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          provider: params.provider || requestedProviderId || undefined
        });
        // Normalize to Chat Completions format (OpenAI tool_calls shape)
        const rawToolCalls = response.toolCalls || response.tool_calls || [];
        const normalizedToolCalls = rawToolCalls.length > 0 ? rawToolCalls.map(tc => ({
          id: tc.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: tc.name || tc.function?.name || 'unknown',
            arguments: typeof tc.arguments === 'string' ? tc.arguments
              : typeof tc.input === 'string' ? tc.input
              : JSON.stringify(tc.arguments || tc.input || tc.function?.arguments || {})
          }
        })) : null;

        return {
          choices: [{
            message: {
              role: 'assistant',
              content: response.content || response.text || '',
              tool_calls: normalizedToolCalls
            }
          }]
        };
      }
    } : null;

    interactiveSession = new InteractiveSession({
      models: { primary: model },
      interactive: {}
    }, sessionContext, console, { client: llmClient });

    res.json({ success: true, sessionId: interactiveSession.sessionId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interactive/message', async (req, res) => {
  try {
    if (!interactiveSession?.active) {
      return res.status(400).json({ success: false, error: 'No active interactive session. Start one first.' });
    }

    const { message, model, provider } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required.' });
    }

    // SSE streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    await interactiveSession.handleMessage(message.trim(), (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }, { model, provider });

    res.write('event: done\ndata: {}\n\n');
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    } else {
      res.write(`event: interactive_error\ndata: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
});

app.get('/api/interactive/status', (_req, res) => {
  res.json({
    success: true,
    active: !!interactiveSession?.active,
    sessionId: interactiveSession?.sessionId || null,
    messageCount: interactiveSession?.messages?.length || 0,
    hasRun: !!activeContext
  });
});

app.post('/api/interactive/stop', (_req, res) => {
  if (interactiveSession) {
    interactiveSession.stop();
    interactiveSession = null;
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// Document Feeder API
// ═══════════════════════════════════════════════════════════════

app.get('/api/feeder/status', async (_req, res) => {
  try {
    if (!activeContext?.runPath) {
      return res.json({ success: true, status: { enabled: false, started: false, reason: 'No active run' } });
    }
    const runPath = activeContext.runPath;
    const manifestPath = path.join(runPath, 'ingestion-manifest.json');
    const pendingPath = path.join(runPath, 'ingestion-pending.json');

    let manifest = {};
    let pending = [];
    try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); } catch {}
    try { pending = JSON.parse(await fsp.readFile(pendingPath, 'utf8')); } catch {}

    const fileCount = Object.keys(manifest).length;
    const nodeCount = Object.values(manifest).reduce((sum, e) => sum + (e.nodeIds?.length || 0), 0);

    res.json({
      success: true,
      status: {
        enabled: true,
        started: !!activeContext.engineProcess,
        manifest: { fileCount, nodeCount, files: manifest },
        pending: { queueLength: pending.length },
        ingestDir: path.join(runPath, 'ingestion', 'documents')
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/feeder/ingest', async (req, res) => {
  try {
    if (!activeContext?.runPath) {
      return res.status(400).json({ success: false, error: 'No active run' });
    }

    const { filePath, dirPath, label } = req.body;
    if (!filePath && !dirPath) {
      return res.status(400).json({ success: false, error: 'filePath or dirPath required' });
    }

    // Copy file to ingestion directory for the watcher to pick up
    const ingestDir = path.join(activeContext.runPath, 'ingestion', 'documents');
    const targetLabel = label || 'api-ingest';
    const targetDir = path.join(ingestDir, targetLabel);
    await fsp.mkdir(targetDir, { recursive: true });

    if (filePath) {
      const fileName = path.basename(filePath);
      const targetPath = path.join(targetDir, fileName);
      await fsp.copyFile(filePath, targetPath);
      res.json({ success: true, message: `File queued for ingestion: ${fileName}`, targetPath });
    } else {
      // Copy directory contents
      const srcFiles = await fsp.readdir(dirPath, { withFileTypes: true });
      let copied = 0;
      for (const entry of srcFiles) {
        if (entry.isFile()) {
          await fsp.copyFile(path.join(dirPath, entry.name), path.join(targetDir, entry.name));
          copied++;
        }
      }
      res.json({ success: true, message: `${copied} files queued for ingestion`, targetDir });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/feeder/watch', async (req, res) => {
  try {
    if (!activeContext?.runPath) {
      return res.status(400).json({ success: false, error: 'No active run' });
    }
    const { watchPath, label } = req.body;
    if (!watchPath) {
      return res.status(400).json({ success: false, error: 'watchPath required' });
    }
    // The watcher path is noted — the engine subprocess handles actual watching.
    // For the server layer, we acknowledge and let the user know to use the ingest endpoint instead.
    res.json({
      success: true,
      message: `Watch path noted. Drop files in ${path.join(activeContext.runPath, 'ingestion', 'documents')} for automatic ingestion, or use POST /api/feeder/ingest to copy files in.`,
      watchPath,
      label: label || path.basename(watchPath)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/feeder/file', async (req, res) => {
  try {
    if (!activeContext?.runPath) {
      return res.status(400).json({ success: false, error: 'No active run' });
    }
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath required' });
    }
    // Remove from manifest (engine will pick up on next state load)
    const manifestPath = path.join(activeContext.runPath, 'ingestion-manifest.json');
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      if (manifest[filePath]) {
        delete manifest[filePath];
        await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
        res.json({ success: true, message: `Removed manifest entry for ${filePath}` });
      } else {
        res.json({ success: true, message: 'File not found in manifest' });
      }
    } catch {
      res.json({ success: true, message: 'No manifest found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── File upload via browser ──────────────────────────────────────────
const feederUploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      if (!activeContext?.runPath) {
        return cb(new Error('No active run'));
      }
      const label = (req.body && req.body.label) || 'documents';
      const sanitized = label.replace(/[^a-zA-Z0-9_-]/g, '_');
      const dir = path.join(activeContext.runPath, 'ingestion', 'documents', sanitized);
      await fsp.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  }
});
const feederUpload = multer({
  storage: feederUploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.post('/api/feeder/upload', (req, res, next) => {
  if (!activeContext?.runPath) {
    return res.status(400).json({ success: false, error: 'No active run. Start a research run first.' });
  }
  feederUpload.array('files', 20)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'File too large (max 100MB)' });
      }
      return res.status(400).json({ success: false, error: err.message });
    }
    try {
      const uploaded = (req.files || []).map(f => ({
        name: f.originalname,
        size: f.size,
        dest: f.path
      }));
      res.json({ success: true, files: uploaded, runPath: activeContext.runPath });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════

const { createHubRouter } = require('./lib/hub-routes');
app.use(createHubRouter({
  localRunsPath: LOCAL_RUNS_PATH,
  getReferenceRunsPaths,
  getActiveContext: () => activeContext,
  engineDir: ENGINE_DIR
}));

app.use(createBrainsRouter({
  getRunsOptions: async () => ({
    localRunsPath: LOCAL_RUNS_PATH,
    referenceRunsPaths: getReferenceRunsPaths(),
    activeRunPath: activeContext?.runPath || null
  }),
  getActiveContext: () => activeContext,
  listBrains,
  resolveBrainBySelector,
  launchResearch
}));

app.post('/api/launch', async (req, res) => {
  try {
    if ((req.body.explorationMode || 'guided') === 'guided' && !String(req.body.topic || '').trim() && !req.body.brainId) {
      return res.status(400).json({
        success: false,
        error: 'Topic is required for guided mode'
      });
    }

    const result = await launchResearch(req.body, req);
    const { brainPath, brainSourceType, ...responsePayload } = result;
    res.json(responsePayload);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/stop', async (_req, res) => {
  if (!activeContext) {
    return res.json({
      status: 'not_running',
      message: 'No research running'
    });
  }

  const runName = activeContext.runName;
  try {
    processManager.recordLog('Launcher', 'info', `Stopping run ${runName}`);
    await processManager.stopAll();
    res.json({
      success: true,
      status: 'stopped'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    activeContext = null;
  }
});

app.get('/api/status', async (req, res) => {
  const processStatus = processManager.getStatus();
  const running = !!activeContext && processStatus.running.some(process => process.name === 'cosmo-main');

  res.json({
    success: true,
    running,
    activeContext,
    processStatus,
    ports: {
      app: PORT,
      websocket: WS_PORT,
      dashboard: DASHBOARD_PORT,
      mcpHttp: MCP_HTTP_PORT
    },
    dashboardUrl: running ? `http://localhost:${DASHBOARD_PORT}` : null,
    wsUrl: running ? getWsUrl(req) : null
  });
});

app.get('/api/watch/logs', async (req, res) => {
  try {
    const after = Number.parseInt(req.query.after || '0', 10) || 0;
    const limit = Number.parseInt(req.query.limit || '250', 10) || 250;
    const payload = processManager.getLogs({ after, limit });
    res.json({
      success: true,
      ...payload,
      running: !!activeContext && processManager.getStatus().running.some(p => p.name === 'cosmo-main'),
      activeContext
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/brain/:name/query', async (req, res) => {
  try {
    const brain = await resolveBrainBySelector(req.params.name, {
      localRunsPath: LOCAL_RUNS_PATH,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: activeContext?.runPath || null
    });

    if (!brain) {
      return res.status(404).json({ error: 'Brain not found' });
    }

    const queryEngine = await getQueryEngine(brain.path);
    const queryDefaults = getCatalogDefaults();
    const result = await queryEngine.executeEnhancedQuery(req.body.query, {
      model: req.body.model || queryDefaults.queryModel || 'gpt-5.2',
      mode: req.body.mode || 'normal',
      includeEvidenceMetrics: parseBoolean(req.body.includeEvidenceMetrics, false),
      enableSynthesis: parseBoolean(req.body.enableSynthesis, true),
      includeCoordinatorInsights: parseBoolean(req.body.includeCoordinatorInsights, true),
      includeFiles: parseBoolean(req.body.includeOutputs, true),
      includeThoughts: parseBoolean(req.body.includeThoughts, true),
      priorContext: req.body.priorContext || null,
      exportFormat: req.body.exportFormat || null,
      allowActions: parseBoolean(req.body.allowActions, false),
      enablePGS: parseBoolean(req.body.enablePGS, false),
      pgsMode: req.body.pgsMode || null,
      pgsSessionId: req.body.pgsSessionId || null,
      pgsFullSweep: parseBoolean(req.body.pgsFullSweep, false),
      pgsConfig: req.body.pgsConfig || null,
      pgsSweepModel: req.body.pgsSweepModel || null,
      explicitProvider: req.body.provider || null
    });

    result.query = req.body.query;
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Query failed',
      message: error.message,
      response: `Query failed: ${error.message}`
    });
  }
});

app.post('/api/brain/:name/query/stream', async (req, res) => {
  try {
    const brain = await resolveBrainBySelector(req.params.name, {
      localRunsPath: LOCAL_RUNS_PATH,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: activeContext?.runPath || null
    });

    if (!brain) {
      return res.status(404).json({ error: 'Brain not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const queryEngine = await getQueryEngine(brain.path);
    const queryDefaults = getCatalogDefaults();
    await queryEngine.executeEnhancedQuery(req.body.query, {
      model: req.body.model || queryDefaults.queryModel || 'gpt-5.2',
      mode: req.body.mode || 'normal',
      includeEvidenceMetrics: parseBoolean(req.body.includeEvidenceMetrics, false),
      enableSynthesis: parseBoolean(req.body.enableSynthesis, true),
      includeCoordinatorInsights: parseBoolean(req.body.includeCoordinatorInsights, true),
      includeFiles: parseBoolean(req.body.includeOutputs, true),
      includeThoughts: parseBoolean(req.body.includeThoughts, true),
      priorContext: req.body.priorContext || null,
      exportFormat: req.body.exportFormat || null,
      allowActions: parseBoolean(req.body.allowActions, false),
      enablePGS: parseBoolean(req.body.enablePGS, false),
      pgsMode: req.body.pgsMode || null,
      pgsSessionId: req.body.pgsSessionId || null,
      pgsFullSweep: parseBoolean(req.body.pgsFullSweep, false),
      pgsConfig: req.body.pgsConfig || null,
      pgsSweepModel: req.body.pgsSweepModel || null,
      explicitProvider: req.body.provider || null,
      onChunk: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }).then(result => {
      res.write(`data: ${JSON.stringify({ type: 'complete', result })}\n\n`);
      res.end();
    }).catch(error => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/brain/:name/suggestions', async (req, res) => {
  try {
    const brain = await resolveBrainBySelector(req.params.name, {
      localRunsPath: LOCAL_RUNS_PATH,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: activeContext?.runPath || null
    });

    if (!brain) {
      return res.status(404).json({ error: 'Brain not found' });
    }

    const queryEngine = await getQueryEngine(brain.path);
    const suggestions = await queryEngine.getQuerySuggestions();
    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      suggestions: []
    });
  }
});

app.get('/api/brain/:name/graph', async (req, res) => {
  try {
    const brain = await resolveBrainBySelector(req.params.name, {
      localRunsPath: LOCAL_RUNS_PATH,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: activeContext?.runPath || null
    });

    if (!brain) {
      return res.status(404).json({ error: 'Brain not found' });
    }

    const brainQueryEngine = await getQueryEngine(brain.path);
    const inner = brainQueryEngine.queryEngine || brainQueryEngine;
    const state = await inner.loadBrainState();
    const memory = state.memory || {};
    const rawNodes = memory.nodes || [];
    const rawEdges = memory.edges || [];
    const rawClusters = memory.clusters || [];

    // Strip embeddings (512 floats per node) to save bandwidth
    const nodes = rawNodes.map(n => ({
      id: n.id,
      concept: n.concept,
      tag: n.tag,
      weight: n.weight,
      activation: n.activation,
      cluster: n.cluster,
      accessCount: n.accessCount,
      created: n.created,
      accessed: n.accessed,
      consolidatedAt: n.consolidatedAt || null
    }));

    const edges = rawEdges.map(e => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
      type: e.type,
      created: e.created
    }));

    res.json({
      success: true,
      nodes,
      edges,
      clusters: rawClusters,
      meta: {
        brainId: brain.id,
        displayName: brain.displayName,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        clusterCount: rawClusters.length,
        cycleCount: state.cycleCount || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Intelligence endpoints — read-only access to any brain's saved state
// ══════════════════════════════════════════════════════════════════════════

async function resolveBrainPath(name) {
  const brain = await resolveBrainBySelector(name, {
    localRunsPath: LOCAL_RUNS_PATH,
    referenceRunsPaths: getReferenceRunsPaths(),
    activeRunPath: activeContext?.runPath || null
  });
  return brain?.path || null;
}

app.get('/api/brain/:name/intelligence/goals', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const qe = await getQueryEngine(brainPath);
    const inner = qe.queryEngine || qe;
    const state = await inner.loadBrainState();
    res.json(state.goals || { active: [], completed: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/plans', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const plansDir = path.join(brainPath, 'plans');
    const milestonesDir = path.join(brainPath, 'milestones');
    const tasksDir = path.join(brainPath, 'tasks');

    // Load main plan
    let plan = null;
    try {
      plan = JSON.parse(await fsp.readFile(path.join(plansDir, 'plan:main.json'), 'utf-8'));
    } catch { /* no plan */ }

    if (!plan) return res.json({ plan: null, milestones: [], tasks: [], archived: [] });

    // Load milestones
    const milestones = [];
    for (const msId of plan.milestones || []) {
      try {
        milestones.push(JSON.parse(await fsp.readFile(path.join(milestonesDir, `${msId}.json`), 'utf-8')));
      } catch { /* skip */ }
    }

    // Load tasks for this plan
    const tasks = [];
    try {
      const entries = await fsp.readdir(tasksDir);
      for (const f of entries) {
        if (f.startsWith('task:') && f.endsWith('.json')) {
          try {
            const task = JSON.parse(await fsp.readFile(path.join(tasksDir, f), 'utf-8'));
            if (task.planId === plan.id) tasks.push(task);
          } catch { /* skip */ }
        }
      }
    } catch { /* no tasks dir */ }

    // Load guided-plan.md
    let planMarkdown = null;
    try { planMarkdown = await fsp.readFile(path.join(brainPath, 'guided-plan.md'), 'utf-8'); } catch { /* nope */ }

    // Load archived plans
    const archived = [];
    try {
      const files = await fsp.readdir(plansDir);
      for (const f of files.filter(f => f.includes('_archived_') && f.endsWith('.json'))) {
        try { archived.push(JSON.parse(await fsp.readFile(path.join(plansDir, f), 'utf-8'))); } catch { /* skip */ }
      }
    } catch { /* no plans dir */ }

    res.json({
      plan,
      milestones,
      activeMilestone: milestones.find(m => m.id === plan.activeMilestone) || null,
      tasks,
      planMarkdown,
      archived
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/thoughts', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const limit = parseInt(req.query.limit) || 100;
    const thoughtsPath = path.join(brainPath, 'thoughts.jsonl');
    const thoughts = [];
    try {
      const content = await fsp.readFile(thoughtsPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (line.trim()) {
          try { thoughts.push(JSON.parse(line)); } catch { /* skip bad line */ }
        }
      }
    } catch { /* no file */ }

    res.json({ thoughts: thoughts.slice(-limit), total: thoughts.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/agents', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const resultsPath = path.join(brainPath, 'coordinator', 'results_queue.jsonl');
    let agents = [];
    try {
      const content = await fsp.readFile(resultsPath, 'utf-8');
      agents = content.trim().split('\n').filter(l => l).map(l => JSON.parse(l));
    } catch { /* no file */ }

    // Summary by type
    const byType = {};
    let completed = 0, failed = 0;
    for (const a of agents) {
      const t = a.agentType || 'Unknown';
      if (!byType[t]) byType[t] = { total: 0, completed: 0, failed: 0, findings: 0 };
      byType[t].total++;
      if (a.status === 'completed') { byType[t].completed++; completed++; }
      if (a.status === 'failed') { byType[t].failed++; failed++; }
      if (a.results) byType[t].findings += a.results.length;
    }

    // Timeline (most recent first)
    const timeline = agents.sort((a, b) =>
      new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime()
    ).map(a => ({
      agentId: a.agentId,
      agentType: a.agentType,
      status: a.status,
      goal: a.mission?.goalId,
      description: a.mission?.description,
      findings: a.results?.filter(r => r.type === 'finding').length || 0,
      insights: a.results?.filter(r => r.type === 'insight').length || 0,
      duration: a.durationFormatted || a.duration,
      startTime: a.startTime,
      endTime: a.endTime
    }));

    res.json({
      summary: { total: agents.length, completed, failed, byType },
      timeline
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseReviewMetadata(content, filename) {
  const meta = {
    cyclesReviewed: null,
    cyclesCount: null,
    thoughtsAnalyzed: null,
    goalsEvaluated: null,
    memoryNodes: null,
    quality: { depth: null, novelty: null, coherence: null }
  };

  // Cycles reviewed — "Cycles Reviewed:** 4 to 14 (10 cycles)" or "cycles reviewed: 15-29"
  const cyclesMatch = content.match(/\*\*Cycles Reviewed:\*\*\s*(.+)/i) || content.match(/cycles reviewed:\s*(.+)/i);
  if (cyclesMatch) {
    meta.cyclesReviewed = cyclesMatch[1].trim();
    const countMatch = cyclesMatch[1].match(/\((\d+)\s*cycles?\)/);
    if (countMatch) meta.cyclesCount = parseInt(countMatch[1]);
    if (!meta.cyclesCount) {
      const rangeMatch = cyclesMatch[1].match(/(\d+)\s*(?:to|-)\s*(\d+)/);
      if (rangeMatch) meta.cyclesCount = parseInt(rangeMatch[2]) - parseInt(rangeMatch[1]);
    }
  }

  // Thoughts analyzed
  const thoughtsMatch = content.match(/Thoughts Analyzed:\s*(\d+)/i) || content.match(/(\d+)\s*thoughts/i);
  if (thoughtsMatch) meta.thoughtsAnalyzed = parseInt(thoughtsMatch[1]);

  // Goals evaluated
  const goalsMatch = content.match(/Goals Evaluated:\s*(\d+)/i) || content.match(/(\d+)\s*goals/i);
  if (goalsMatch) meta.goalsEvaluated = parseInt(goalsMatch[1]);

  // Memory nodes
  const nodesMatch = content.match(/Memory Nodes:\s*(\d+)/i) || content.match(/(\d+)\s*nodes/i);
  if (nodesMatch) meta.memoryNodes = parseInt(nodesMatch[1]);

  // Quality scores — "Depth: 3 —" or "Depth: 7/10" or "depth 5"
  const depthMatch = content.match(/[-•]\s*Depth:\s*(\d+)/i);
  if (depthMatch) meta.quality.depth = parseInt(depthMatch[1]);

  const noveltyMatch = content.match(/[-•]\s*Novelty:\s*(\d+)/i);
  if (noveltyMatch) meta.quality.novelty = parseInt(noveltyMatch[1]);

  const coherenceMatch = content.match(/[-•]\s*Coherence:\s*(\d+)/i);
  if (coherenceMatch) meta.quality.coherence = parseInt(coherenceMatch[1]);

  // Sections
  const sections = {
    summary: null,
    keyInsights: [],
    strategicRecommendations: [],
    decisions: []
  };

  // Summary — text after "## Summary" until next "---" or "## "
  const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n---|\n## (?!Summary))/);
  if (summaryMatch) sections.summary = summaryMatch[1].trim();

  // Key Insights / Standout Insights — extract bullet points
  const insightsMatch = content.match(/(?:Key Insights|Standout Insights|Key insights)[^\n]*\n([\s\S]*?)(?=\n---|\n## )/i);
  if (insightsMatch) {
    sections.keyInsights = insightsMatch[1]
      .split('\n')
      .filter(l => /^\s*[-•*]\s/.test(l))
      .map(l => l.replace(/^\s*[-•*]\s+/, '').trim())
      .filter(Boolean);
  }

  // Strategic Recommendations / Strategic directives
  const stratMatch = content.match(/## (?:Strategic Recommendations|Strategic directives)[^\n]*\n([\s\S]*?)(?=\n## |$)/i);
  if (stratMatch) {
    sections.strategicRecommendations = stratMatch[1]
      .split('\n')
      .filter(l => /^\s*[-•*\d]+[.)]\s/.test(l) || /^\s*[-•*]\s/.test(l))
      .map(l => l.replace(/^\s*[-•*\d]+[.)]\s*/, '').trim())
      .filter(Boolean);
  }

  // Decisions — "## Strategic Decisions" or "## Decisions Made"
  const decisionsMatch = content.match(/## (?:Strategic Decisions|Decisions Made|Decisions)[^\n]*\n([\s\S]*?)(?=\n## |$)/i);
  if (decisionsMatch) {
    // Capture sub-section titles as decision items if they exist
    const decisionLines = decisionsMatch[1]
      .split('\n')
      .filter(l => /^\s*[-•*\d]+[.)]\s/.test(l) || /^\s*[-•*]\s/.test(l) || /^## \d+\)/.test(l))
      .map(l => l.replace(/^\s*[-•*\d]+[.)]\s*/, '').replace(/^## \d+\)\s*/, '').trim())
      .filter(Boolean);
    if (decisionLines.length) sections.decisions = decisionLines;
  }

  return { meta, sections };
}

app.get('/api/brain/:name/intelligence/insights', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const coordDir = path.join(brainPath, 'coordinator');
    const reviews = [];
    const insights = [];

    try {
      const files = await fsp.readdir(coordDir);
      for (const f of files) {
        if (f.startsWith('review_') && f.endsWith('.md')) {
          try {
            const content = await fsp.readFile(path.join(coordDir, f), 'utf-8');
            const cycleMatch = f.match(/review_(\d+)/);
            const parsed = parseReviewMetadata(content, f);
            reviews.push({
              filename: f,
              cycle: cycleMatch ? parseInt(cycleMatch[1]) : 0,
              preview: content.slice(0, 300),
              length: content.length,
              meta: parsed.meta,
              sections: parsed.sections
            });
          } catch { /* skip */ }
        }
        if (f.startsWith('insights_curated_') && f.endsWith('.md')) {
          try {
            const content = await fsp.readFile(path.join(coordDir, f), 'utf-8');
            insights.push({
              filename: f,
              preview: content.slice(0, 300),
              length: content.length
            });
          } catch { /* skip */ }
        }
      }
    } catch { /* no coordinator dir */ }

    reviews.sort((a, b) => b.cycle - a.cycle);
    res.json({ reviews, insights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/insight/:filename', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const safeName = path.basename(req.params.filename);
    const filePath = path.join(brainPath, 'coordinator', safeName);
    const content = await fsp.readFile(filePath, 'utf-8');
    res.json({ filename: safeName, markdown: content });
  } catch (error) {
    res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/trajectory', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const qe = await getQueryEngine(brainPath);
    const inner = qe.queryEngine || qe;
    const state = await inner.loadBrainState();
    res.json({
      trajectory: state.trajectory || null,
      forks: state.forkSystem || state.cognition?.forks || null,
      cycleCount: state.cycleCount || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/executive', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const qe = await getQueryEngine(brainPath);
    const inner = qe.queryEngine || qe;
    const state = await inner.loadBrainState();

    if (state.executiveRing) {
      return res.json({
        available: true,
        stats: state.executiveRing,
        cycleCount: state.cycleCount || 0
      });
    }
    res.json({ available: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/:name/intelligence/deliverables', async (req, res) => {
  try {
    const brainPath = await resolveBrainPath(req.params.name);
    if (!brainPath) return res.status(404).json({ error: 'Brain not found' });

    const outputsDir = path.join(brainPath, 'outputs');
    const deliverables = [];

    try {
      const dirs = await fsp.readdir(outputsDir, { withFileTypes: true });
      for (const d of dirs.filter(d => d.isDirectory())) {
        const agentDir = path.join(outputsDir, d.name);
        const isComplete = fs.existsSync(path.join(agentDir, '.complete'));
        let fileCount = 0;
        const filesList = [];
        try {
          const allFiles = await fsp.readdir(agentDir);
          const visibleFiles = allFiles.filter(f => !f.startsWith('.'));
          fileCount = visibleFiles.length;
          const filesToList = visibleFiles.slice(0, 50);
          for (const fileName of filesToList) {
            try {
              const fileStat = await fsp.stat(path.join(agentDir, fileName));
              filesList.push({ name: fileName, size: fileStat.size });
            } catch {
              filesList.push({ name: fileName, size: null });
            }
          }
        } catch { /* skip */ }

        const stat = await fsp.stat(agentDir);
        deliverables.push({
          agentId: d.name,
          isComplete,
          fileCount,
          files: filesList,
          createdAt: stat.birthtime?.toISOString() || stat.mtime.toISOString(),
          modifiedAt: stat.mtime.toISOString()
        });
      }
    } catch { /* no outputs dir */ }

    deliverables.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json({ deliverables, total: deliverables.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════

app.post('/api/brain/:name/export-query', async (req, res) => {
  try {
    const brain = await resolveBrainBySelector(req.params.name, {
      localRunsPath: LOCAL_RUNS_PATH,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: activeContext?.runPath || null
    });

    if (!brain) {
      return res.status(404).json({ error: 'Brain not found' });
    }

    const queryEngine = await getQueryEngine(brain.path);
    const filepath = await queryEngine.exportResult(
      req.body.query,
      req.body.answer,
      req.body.format || 'markdown',
      req.body.metadata || {}
    );

    res.json({
      success: true,
      exportedTo: filepath,
      filepath,
      relativePath: path.relative(brain.path, filepath),
      filename: path.basename(filepath)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, async () => {
  await applyStoredConfig();
  await fsp.mkdir(LOCAL_RUNS_PATH, { recursive: true });
  const repairSummary = await repairAllRunMetadata(LOCAL_RUNS_PATH, console);
  console.log(`[cosmo_2.3] http://localhost:${PORT}`);
  console.log(`[cosmo_2.3] local config: ${getConfigPath()}`);
  console.log(`[cosmo_2.3] reference runs: ${getReferenceRunsPaths().join(', ') || 'none'}`);
  console.log(`[cosmo_2.3] run metadata repair: ${repairSummary.repaired}/${repairSummary.scanned} repaired`);
});
