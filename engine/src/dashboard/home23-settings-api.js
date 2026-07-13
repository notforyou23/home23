const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const { Home23TileService } = require('./home23-tiles');
const {
  updateDashboardOAuthTokenSecrets,
  updateSettingsSecrets,
} = require('./home23-secrets');
const { writeYamlSafely } = require('./yaml-write-safety');
const { StateCompression } = require('../core/state-compression');
const { readJsonlGz, sidecarsExist, nodesPath } = require('../core/memory-sidecar');
const { buildAgentConfig, buildFeederConfig } = require('../../../cli/lib/agent-config-builder.cjs');
const { buildHome23ModelAuthority } = require('./home23-model-catalog.js');

const PM2_ENV_BLOCKLIST = [
  'cron_restart',
  'watch',
  'HOME23_AGENT',
  'INSTANCE_ID',
  'DASHBOARD_PORT',
  'COSMO_DASHBOARD_PORT',
  'REALTIME_PORT',
  'MCP_HTTP_PORT',
  'COSMO_RUNTIME_DIR',
  'COSMO_WORKSPACE_PATH',
  'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY',
];

const SHARED_PM2_PROCESS_NAMES = new Set([
  'home23-cosmo23',
  'home23-evobrew',
  'home23-screenlogic',
]);

function assertNoSharedPm2Targets(targets) {
  const sharedTarget = targets.find(name => SHARED_PM2_PROCESS_NAMES.has(name));
  if (sharedTarget) {
    throw new Error(`Refusing generic PM2 mutation for shared service: ${sharedTarget}`);
  }
}

function cleanPm2Env(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of PM2_ENV_BLOCKLIST) delete env[key];
  return env;
}

function planModelAuthorityRuntimeTargets({
  agent,
  agentNames = [],
  globalCatalogChanged = false,
  affectsManagedCosmo = false,
} = {}) {
  const dashboards = globalCatalogChanged
    ? agentNames
    : [agent];
  const targets = [];
  if (affectsManagedCosmo) targets.push('home23-cosmo23');
  for (const name of dashboards) {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (normalized) targets.push(`home23-${normalized}-dash`);
  }
  return [...new Set(targets)];
}

async function applyModelAuthorityRuntimeRefresh({
  change = {},
  currentAgent = null,
  agentNames = [],
  reloadCurrentDashboard,
  restartProcesses,
} = {}) {
  if (typeof restartProcesses !== 'function') {
    throw new Error('Model authority process refresh is unavailable');
  }
  const planned = planModelAuthorityRuntimeTargets({ ...change, agentNames });
  const currentDashboard = currentAgent ? `home23-${currentAgent}-dash` : null;
  const shouldReloadCurrent = currentDashboard && planned.includes(currentDashboard);
  const externalTargets = planned.filter(name => name !== currentDashboard);
  const restarted = externalTargets.length > 0
    ? await restartProcesses(externalTargets)
    : [];
  if (!Array.isArray(restarted)
      || restarted.some(name => !externalTargets.includes(name))) {
    throw new Error('Model authority process refresh returned invalid evidence');
  }
  const refreshed = [];
  if (shouldReloadCurrent) {
    if (typeof reloadCurrentDashboard !== 'function') {
      throw new Error('Current dashboard model authority reload is unavailable');
    }
    await reloadCurrentDashboard(change);
    refreshed.push(currentDashboard);
  }
  return Object.freeze({ refreshed, restarted: [...restarted] });
}

function createSettingsRouter(home23Root, options = {}) {
  const router = express.Router();
  const tileService = new Home23TileService({ home23Root });
  const getOrchestrator = typeof options.getOrchestrator === 'function'
    ? options.getOrchestrator
    : () => null;
  const resolveCurrentDashboardAgent = typeof options.getCurrentDashboardAgent === 'function'
    ? options.getCurrentDashboardAgent
    : () => getCurrentDashboardAgent();
  const seedModelAuthority = typeof options.seedModelAuthority === 'function'
    ? options.seedModelAuthority
    : async () => {
      const moduleUrl = pathToFileURL(
        path.join(home23Root, 'cli', 'lib', 'cosmo23-config.js'),
      ).href;
      const { seedCosmo23Config: seed } = await import(moduleUrl);
      return seed(home23Root);
    };
  const onModelAuthorityChanged = typeof options.onModelAuthorityChanged === 'function'
    ? options.onModelAuthorityChanged
    : (change) => applyModelAuthorityRuntimeRefresh({
      change,
      currentAgent: resolveCurrentDashboardAgent(),
      agentNames: discoverAgents(),
      reloadCurrentDashboard: options.reloadCurrentDashboardModelAuthority,
      restartProcesses: restartOnlineProcessesWithSharedLock,
    });
  const recycleModelProcess = typeof options.recycleManagedProcess === 'function'
    ? options.recycleManagedProcess
    : (name) => recycleManagedProcess(name);

  function loadYaml(filePath) {
    if (!fs.existsSync(filePath)) return {};
    return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  }

  function saveYaml(filePath, data) {
    return writeYamlSafely(filePath, data, {
      yaml,
      lineWidth: 120,
      rootDir: home23Root,
      logger: console,
    });
  }

  function cloneConfig(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function modelPairError(label, provider, model) {
    return Object.assign(
      new Error(`${label} must be an exact configured provider/model pair: ${provider || 'missing'}/${model || 'missing'}`),
      { code: 'model_pair_invalid', retryable: false },
    );
  }

  function assertExactConfiguredPair(authority, provider, model, label) {
    const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (!normalizedProvider || !normalizedModel || !authority.models.some((entry) => (
      entry.provider === normalizedProvider && entry.model === normalizedModel
    ))) {
      throw modelPairError(label, normalizedProvider, normalizedModel);
    }
  }

  function validateModelAuthority(homeConfig, agentConfig) {
    const authority = buildHome23ModelAuthority({ homeConfig, agentConfig });
    const query = agentConfig.query === undefined || agentConfig.query === null
      ? (homeConfig.query || {})
      : agentConfig.query;
    const chat = agentConfig.chat || homeConfig.chat || {};
    const directProvider = query.defaultProvider || query.provider
      || chat.defaultProvider || chat.provider;
    const directModel = query.defaultModel || chat.defaultModel || chat.model;
    const sweepProvider = query.pgsSweepProvider || directProvider;
    const sweepModel = query.pgsSweepModel || directModel;
    const synthProvider = query.pgsSynthProvider || directProvider;
    const synthModel = query.pgsSynthModel || directModel;
    assertExactConfiguredPair(authority, directProvider, directModel, 'Direct Query model');
    assertExactConfiguredPair(authority, sweepProvider, sweepModel, 'PGS sweep model');
    assertExactConfiguredPair(authority, synthProvider, synthModel, 'PGS synthesis model');
    return authority;
  }

  async function refreshModelAuthority({ rollback, ...change }) {
    let runtimeRefreshStarted = false;
    try {
      await seedModelAuthority({ home23Root, ...change });
      runtimeRefreshStarted = true;
      return await onModelAuthorityChanged({ home23Root, ...change });
    } catch (error) {
      rollback();
      try {
        await seedModelAuthority({
          home23Root,
          ...change,
          reason: `${change.reason}-rollback`,
        });
      } catch (rollbackError) {
        console.error('[Settings] Failed to restore managed model authority after rollback:', rollbackError.message);
      }
      if (runtimeRefreshStarted) {
        try {
          await onModelAuthorityChanged({
            home23Root,
            ...change,
            reason: `${change.reason}-rollback`,
            rollback: true,
          });
        } catch (rollbackError) {
          console.error('[Settings] Failed to restore runtime model authority after rollback:', rollbackError.message);
        }
      }
      throw error;
    }
  }

  function getHome23Version() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(home23Root, 'package.json'), 'utf8'));
      return pkg.version || '0.6.0';
    } catch {
      return '0.6.0';
    }
  }

  function seedCosmo23Config() {
    const { execSync } = require('child_process');
    execSync(`node --input-type=module -e "
      import { seedCosmo23Config } from './cli/lib/cosmo23-config.js';
      await seedCosmo23Config('.');
    "`, { cwd: home23Root, stdio: 'pipe', timeout: 10000 });
  }

  function discoverAgents() {
    const instancesDir = path.join(home23Root, 'instances');
    if (!fs.existsSync(instancesDir)) return [];
    return fs.readdirSync(instancesDir).filter(name => {
      const dir = path.join(instancesDir, name);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'config.yaml'));
    });
  }

  function chooseFallbackPrimaryAgent(agentNames = discoverAgents()) {
    if (!Array.isArray(agentNames) || agentNames.length === 0) return null;
    const ranked = agentNames.map(name => {
      const config = loadYaml(path.join(home23Root, 'instances', name, 'config.yaml'));
      return {
        name,
        dashboardPort: Number(config.ports?.dashboard) || Number.MAX_SAFE_INTEGER,
        enginePort: Number(config.ports?.engine) || Number.MAX_SAFE_INTEGER,
      };
    });
    ranked.sort((a, b) =>
      a.dashboardPort - b.dashboardPort
      || a.enginePort - b.enginePort
      || a.name.localeCompare(b.name)
    );
    return ranked[0]?.name || null;
  }

  function stripHome23Prefix(value) {
    return String(value || '').replace(/^home23-/, '').trim();
  }

  function getPrimaryAgent(options = {}) {
    const { autoHeal = false } = options;
    const homeConfig = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    const configured = String(homeConfig.home?.primaryAgent || '').trim();
    const agentNames = discoverAgents();
    if (configured && agentNames.includes(configured)) {
      return configured;
    }
    const fallback = chooseFallbackPrimaryAgent(agentNames);
    if (autoHeal && fallback && configured !== fallback) {
      setPrimaryAgent(fallback);
    }
    return fallback;
  }

  function getCurrentDashboardAgent() {
    const current = stripHome23Prefix(process.env.HOME23_AGENT || process.env.INSTANCE_ID);
    const agents = discoverAgents();
    return current && agents.includes(current) ? current : null;
  }

  function resolveRequestedAgent(candidate, options = {}) {
    const { autoHealPrimary = true, fallbackToCurrent = true, fallbackToPrimary = true } = options;
    const agents = discoverAgents();
    if (agents.length === 0) return null;

    const requested = stripHome23Prefix(candidate);
    if (requested) {
      return agents.includes(requested) ? requested : null;
    }

    if (fallbackToCurrent) {
      const current = getCurrentDashboardAgent();
      if (current) return current;
    }

    if (fallbackToPrimary) {
      const primary = getPrimaryAgent({ autoHeal: autoHealPrimary });
      if (primary) return primary;
    }

    return chooseFallbackPrimaryAgent(agents);
  }

  function loadAgentConfig(agentName) {
    if (!agentName) return {};
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    return fs.existsSync(configPath) ? (loadYaml(configPath) || {}) : {};
  }

  function setPrimaryAgent(name) {
    const configPath = path.join(home23Root, 'config', 'home.yaml');
    const homeConfig = loadYaml(configPath);
    if (!homeConfig.home) homeConfig.home = {};
    homeConfig.home.primaryAgent = name;
    saveYaml(configPath, homeConfig);
  }

  function listOnlinePm2ProcessNames() {
    const { execFileSync } = require('child_process');
    const { parsePm2JlistOutput } = require(path.join(home23Root, 'scripts', 'home23-pm2-watchdog.cjs'));
    const jlist = parsePm2JlistOutput(execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      env: cleanPm2Env(),
      stdio: 'pipe',
      timeout: 10000,
    }));
    return new Set(
      jlist
        .filter(proc => proc.pm2_env?.status === 'online' && Number(proc.pid))
        .map(proc => proc.name)
    );
  }

  function restartOnlineEcosystemProcesses(targets) {
    assertNoSharedPm2Targets(targets);
    const { execFileSync } = require('child_process');
    const ecosystemPath = path.join(home23Root, 'ecosystem.config.cjs');
    const online = listOnlinePm2ProcessNames();
    const activeTargets = targets.filter(name => online.has(name));

    if (activeTargets.length > 0) {
      const args = ['restart', ecosystemPath, '--only', activeTargets.join(','), '--update-env', '--silent'];
      try {
        execFileSync('pm2', args, { cwd: home23Root, env: cleanPm2Env(), stdio: 'pipe', timeout: 45000 });
      } catch {
        execFileSync('pm2', ['start', ecosystemPath, '--only', activeTargets.join(','), '--update-env', '--silent'], {
          cwd: home23Root,
          env: cleanPm2Env(),
          stdio: 'pipe',
          timeout: 45000,
        });
      }
    }
    return activeTargets;
  }

  async function restartOnlineProcessesWithSharedLock(targets) {
    const online = listOnlinePm2ProcessNames();
    const activeTargets = [...new Set(targets)].filter(name => online.has(name));
    const nonSharedTargets = activeTargets.filter(name => !SHARED_PM2_PROCESS_NAMES.has(name));
    const sharedTargets = activeTargets.filter(name => SHARED_PM2_PROCESS_NAMES.has(name));
    const restarted = [];

    if (sharedTargets.length > 0) {
      const sharedStart = await import(pathToFileURL(
        path.join(home23Root, 'cli', 'lib', 'shared-service-start.js')
      ).href);
      for (const name of sharedTargets) {
        const service = sharedStart.SHARED_SERVICES.find(candidate => candidate.name === name);
        if (!service) throw new Error(`Shared-service definition is missing for ${name}`);
        await sharedStart.coordinateSharedServiceStartup({
          home23Root,
          services: [service],
          restartOnline: true,
        });
        restarted.push(name);
      }
    }

    // Restart dashboards last. This process may itself be one of the targets;
    // shared authority must already be online before PM2 replaces it.
    if (nonSharedTargets.length > 0) {
      restarted.push(...restartOnlineEcosystemProcesses(nonSharedTargets));
    }

    const verifiedOnline = listOnlinePm2ProcessNames();
    for (const name of restarted) {
      if (!verifiedOnline.has(name)) {
        throw new Error(`Model authority runtime did not return online: ${name}`);
      }
    }

    return restarted;
  }

  function recycleManagedProcess(name) {
    if (!name) return false;
    return restartOnlineEcosystemProcesses([name]).includes(name);
  }

  function syncAgentDefaultModelFiles(agentName, provider, model) {
    if (!agentName || !provider || !model) return;
    const modelJson = JSON.stringify({
      model: String(model).trim(),
      provider: String(provider).trim(),
    });
    const directories = [
      path.join(home23Root, 'instances', agentName, 'conversations'),
      path.join(home23Root, 'instances', agentName, 'brain'),
    ];
    for (const dir of directories) {
      try { fs.writeFileSync(path.join(dir, 'default-model.json'), modelJson); } catch { /* best-effort */ }
    }
  }

  const SETTINGS_SCOPE_REGISTRY = Object.freeze({
    providers: {
      kind: 'global',
      chip: 'Global',
      agentTarget: 'none',
      summaryTemplate: 'Providers is house-wide. Changes here affect every Home23 agent, harness, and shared model surface.',
      routes: [
        { method: 'GET', path: '/providers' },
        { method: 'PUT', path: '/providers' },
        { method: 'POST', path: '/providers/:name/test' },
        { method: 'GET', path: '/oauth/status' },
        { method: 'POST', path: '/oauth/anthropic/import-cli' },
        { method: 'GET', path: '/oauth/anthropic/start' },
        { method: 'POST', path: '/oauth/anthropic/callback' },
        { method: 'POST', path: '/oauth/anthropic/logout' },
        { method: 'POST', path: '/oauth/openai-codex/import-evobrew' },
        { method: 'POST', path: '/oauth/openai-codex/start' },
        { method: 'POST', path: '/oauth/openai-codex/logout' },
      ],
    },
    agents: {
      kind: 'roster',
      chip: 'Roster',
      agentTarget: 'roster',
      summaryTemplate: 'Agents manages the multi-agent roster. Create agents, choose the home primary, and control each runtime independently.',
      routes: [
        { method: 'GET', path: '/agents' },
        { method: 'POST', path: '/agents' },
        { method: 'PUT', path: '/agents/:name' },
        { method: 'POST', path: '/agents/:name/primary' },
        { method: 'DELETE', path: '/agents/:name' },
        { method: 'POST', path: '/agents/:name/start' },
        { method: 'POST', path: '/agents/:name/restart-engine' },
        { method: 'POST', path: '/agents/:name/restart-harness' },
        { method: 'POST', path: '/agents/:name/stop' },
      ],
    },
    models: {
      kind: 'mixed',
      chip: 'Mixed',
      agentTarget: 'selected',
      summaryTemplate: 'Models is mixed-scope. {{selectedAgent}} gets chat defaults, pulse voice, and cognitive routing. Provider catalogs and aliases stay house-wide.',
      routes: [
        { method: 'GET', path: '/models' },
        { method: 'PUT', path: '/models' },
        { method: 'GET', path: '/model-assignments' },
        { method: 'PUT', path: '/model-assignments' },
        { method: 'GET', path: '/pulse-voice' },
        { method: 'PUT', path: '/pulse-voice' },
      ],
    },
    query: {
      kind: 'agent',
      chip: 'Agent',
      agentTarget: 'selected',
      summaryTemplate: "Query defaults are saved on {{selectedAgent}}. They seed that agent's Query tab only.",
      routes: [
        { method: 'GET', path: '/query' },
        { method: 'PUT', path: '/query' },
      ],
    },
    feeder: {
      kind: 'agent',
      chip: 'Agent',
      agentTarget: 'selected',
      summaryTemplate: "Document Feeder belongs to {{selectedAgent}}. Watch paths, live status, uploads, and restarts target that agent's ingestion pipeline.",
      routes: [
        { method: 'GET', path: '/feeder' },
        { method: 'PUT', path: '/feeder' },
      ],
    },
    skills: {
      kind: 'global',
      chip: 'Global',
      agentTarget: 'none',
      summaryTemplate: 'Skills is house-wide. Skill configuration and credentials are shared across the Home23 system.',
      routes: [
        { method: 'GET', path: '/skills' },
        { method: 'PUT', path: '/skills' },
      ],
    },
    vibe: {
      kind: 'global',
      chip: 'Global',
      agentTarget: 'none',
      summaryTemplate: 'Vibe is house-wide. Changes here affect the visual generation layer for the whole Home23 install.',
      routes: [
        { method: 'GET', path: '/vibe' },
        { method: 'PUT', path: '/vibe' },
      ],
    },
    tiles: {
      kind: 'global',
      chip: 'Global',
      agentTarget: 'none',
      summaryTemplate: 'Tiles is house-wide. Home tile definitions and layout rules are shared across dashboards.',
      routes: [
        { method: 'GET', path: '/tiles' },
        { method: 'PUT', path: '/tiles' },
      ],
    },
    agency: {
      kind: 'mixed',
      chip: 'Mixed',
      agentTarget: 'selected',
      summaryTemplate: 'Agency is mixed-scope. The allow-list is house-wide, while the audit trails below show what {{selectedAgent}} actually attempted.',
      routes: [
        { method: 'GET', path: '/agency/allowlist' },
        { method: 'PUT', path: '/agency/allowlist' },
        { method: 'GET', path: '/agency/recent' },
        { method: 'GET', path: '/agency/requested' },
      ],
    },
    system: {
      kind: 'global',
      chip: 'Global',
      agentTarget: 'none',
      summaryTemplate: 'System is house-wide. Ports, shared services, and install/build actions affect the Home23 host itself.',
      routes: [
        { method: 'GET', path: '/system' },
        { method: 'PUT', path: '/system' },
        { method: 'POST', path: '/system/install' },
        { method: 'POST', path: '/system/build' },
      ],
    },
  });

  function serializeSettingsScopeRegistry() {
    return Object.fromEntries(
      Object.entries(SETTINGS_SCOPE_REGISTRY).map(([key, value]) => [key, {
        kind: value.kind,
        chip: value.chip,
        agentTarget: value.agentTarget,
        summaryTemplate: value.summaryTemplate,
        routes: value.routes.map(route => ({ ...route })),
      }])
    );
  }

  // ── Status (first-run detection) ──
  router.get('/status', (req, res) => {
    const agents = discoverAgents();
    const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
    const hasSecrets = fs.existsSync(secretsPath);
    res.json({
      hasAgents: agents.length > 0,
      agentCount: agents.length,
      initialized: hasSecrets,
      currentAgent: getCurrentDashboardAgent(),
      primaryAgent: getPrimaryAgent({ autoHeal: true }),
      scopeRegistryVersion: 1,
    });
  });

  router.get('/scope', (req, res) => {
    const currentAgent = getCurrentDashboardAgent();
    const primaryAgent = getPrimaryAgent({ autoHeal: true });
    const selectedAgent = resolveRequestedAgent(req.query.agent);
    const agents = discoverAgents().map((name) => {
      const config = loadAgentConfig(name);
      return {
        name,
        displayName: config.agent?.displayName || name,
        isPrimary: name === primaryAgent,
        isCurrentDashboard: name === currentAgent,
      };
    });

    res.json({
      version: 1,
      tabs: serializeSettingsScopeRegistry(),
      currentAgent,
      primaryAgent,
      selectedAgent,
      agents,
    });
  });

  router.get('/setup/readiness', async (req, res) => {
    const homeConfig = loadHomeConfig();
    const secrets = loadSecrets();
    const targetAgent = resolveRequestedAgent(req.query.agent);
    const primaryAgent = getPrimaryAgent({ autoHeal: true });
    const memoryCounts = await readAgentMemorySummary(targetAgent || primaryAgent);
    const embedding = getPrimaryEmbeddingProvider(homeConfig, secrets);
    const providersWithKeys = Array.from(configuredApiKeyProviders(secrets));
    const chatProvider = req.query.provider
      ? String(req.query.provider)
      : getSimpleModelPlan(targetAgent || primaryAgent).chat.provider;
    const selectedProviderReady = chatProvider
      ? isSelectedProviderConfigured(chatProvider, secrets)
      : providersWithKeys.length > 0;
    const memoryMode = embedding.configured
      ? (memoryCounts.missing > 0 ? 'backfill_needed' : 'semantic_ready')
      : 'memory_lite';

    res.json({
      ok: true,
      agent: targetAgent || primaryAgent || null,
      providers: {
        configured: providersWithKeys,
        selected: chatProvider || null,
        selectedReady: selectedProviderReady,
      },
      memory: {
        mode: memoryMode,
        label: memoryMode === 'semantic_ready'
          ? 'Semantic Brain'
          : memoryMode === 'backfill_needed'
            ? 'Backfill Needed'
            : 'Memory Lite',
        embedding,
        nodes: memoryCounts,
        canBackfill: embedding.configured && memoryCounts.missing > 0,
      },
      modelPlan: targetAgent || primaryAgent ? getSimpleModelPlan(targetAgent || primaryAgent) : null,
    });
  });

  router.post('/memory/backfill-embeddings', async (req, res) => {
    const targetAgent = resolveRequestedAgent(req.body?.agent || req.query.agent);
    if (!targetAgent) {
      return res.status(400).json({ ok: false, error: 'No target agent selected' });
    }

    const embedding = getPrimaryEmbeddingProvider();
    if (!embedding.configured) {
      return res.status(400).json({
        ok: false,
        error: 'No embedding provider is configured. Add Ollama Local, OpenAI, or Ollama Cloud embeddings first.',
      });
    }

    const orchestrator = getOrchestrator();
    const currentAgent = getCurrentDashboardAgent();
    const liveMemory = currentAgent === targetAgent ? orchestrator?.memory : null;
    const liveBackfill = currentAgent === targetAgent && typeof orchestrator?._regenerateEmbeddingsInBackground === 'function' && liveMemory?.nodes;

    if (liveBackfill) {
      const missingIds = Array.from(liveMemory.nodes.values())
        .filter((node) => !node?.embedding)
        .map((node) => node.id)
        .filter((id) => id !== undefined && id !== null);

      if (missingIds.length === 0) {
        return res.json({ ok: true, agent: targetAgent, queued: false, mode: 'live', missing: 0 });
      }
      if (orchestrator.__home23EmbeddingBackfillActive) {
        return res.json({ ok: true, agent: targetAgent, queued: true, mode: 'live', alreadyRunning: true, missing: missingIds.length });
      }

      orchestrator.__home23EmbeddingBackfillActive = true;
      orchestrator._regenerateEmbeddingsInBackground(missingIds)
        .catch((error) => console.warn('[Settings] Embedding backfill failed:', error.message))
        .finally(() => { orchestrator.__home23EmbeddingBackfillActive = false; });

      return res.json({ ok: true, agent: targetAgent, queued: true, mode: 'live', missing: missingIds.length });
    }

    const request = {
      requestedAt: new Date().toISOString(),
      agent: targetAgent,
      provider: embedding.provider,
      model: embedding.model,
      status: 'pending_next_engine_load',
      note: 'The engine regenerates missing embeddings in the background when it loads memory with an embedding provider configured.',
    };
    const brainDir = path.join(home23Root, 'instances', targetAgent, 'brain');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.appendFileSync(path.join(brainDir, 'embedding-backfill-requests.jsonl'), JSON.stringify(request) + '\n', 'utf8');
    fs.writeFileSync(path.join(brainDir, 'embedding-backfill-request.json'), JSON.stringify(request, null, 2), 'utf8');

    res.json({ ok: true, agent: targetAgent, queued: true, mode: 'pending_next_engine_load', request });
  });

  // ── Task 2: Providers API ──

  function maskKey(key) {
    if (!key || key.length < 10) return key ? '***' : '';
    return key.slice(0, 8) + '...' + key.slice(-4);
  }

  function getHomeConfigPath() {
    return path.join(home23Root, 'config', 'home.yaml');
  }

  function getSecretsPath() {
    return path.join(home23Root, 'config', 'secrets.yaml');
  }

  function loadHomeConfig() {
    return loadYaml(getHomeConfigPath());
  }

  function loadSecrets() {
    return loadYaml(getSecretsPath());
  }

  function configuredApiKeyProviders(secrets = loadSecrets()) {
    const providers = secrets.providers || {};
    return new Set(
      Object.entries(providers)
        .filter(([, config]) => !!config?.apiKey)
        .map(([name]) => name)
    );
  }

  function isApiKeyProviderConfigured(provider, secrets = loadSecrets()) {
    if (provider === 'ollama-local') return true;
    return configuredApiKeyProviders(secrets).has(provider);
  }

  function isSelectedProviderConfigured(provider, secrets = loadSecrets()) {
    if (!provider) return false;
    return isApiKeyProviderConfigured(provider, secrets);
  }

  function assertSelectedChatProviderReady(provider, model) {
    const resolvedProvider = String(provider || '').trim();
    const resolvedModel = String(model || '').trim();
    if (!resolvedProvider) {
      return { ok: false, error: 'Choose a chat provider before creating the agent.' };
    }
    if (!resolvedModel) {
      return { ok: false, error: 'Choose a chat model before creating the agent.' };
    }
    if (!isSelectedProviderConfigured(resolvedProvider)) {
      const label = resolvedProvider === 'openai-codex'
        ? 'OpenAI Codex'
        : resolvedProvider === 'anthropic'
          ? 'Anthropic'
          : resolvedProvider;
      return {
        ok: false,
        error: `${label} is selected for chat but is not configured yet. Connect it in Providers, then create the agent.`,
      };
    }
    return { ok: true };
  }

  function getPrimaryEmbeddingProvider(homeConfig = loadHomeConfig(), secrets = loadSecrets()) {
    const providers = Array.isArray(homeConfig.embeddings?.providers) ? homeConfig.embeddings.providers : [];
    const primary = providers.find((entry) => entry?.provider && entry?.model) || null;
    if (!primary) {
      return {
        configured: false,
        status: 'memory_lite',
        label: 'Memory Lite',
        message: 'No embedding provider is configured. Text memory and keyword retrieval are available.',
        provider: null,
        model: null,
      };
    }

    const provider = String(primary.provider || '').trim();
    const needsKey = provider !== 'ollama-local';
    const hasKey = !needsKey || !!secrets.providers?.[provider]?.apiKey;
    return {
      configured: hasKey,
      status: hasKey ? 'semantic_configured' : 'memory_lite',
      label: hasKey ? 'Semantic Brain' : 'Memory Lite',
      message: hasKey
        ? 'Embedding provider is configured. Semantic memory can be used and backfilled.'
        : `${provider} embeddings are listed but no credential is saved. Memory Lite remains active.`,
      provider,
      model: primary.model || '',
      dimensions: primary.dimensions || null,
      endpoint: primary.endpoint || null,
      needsKey,
    };
  }

  function countMemoryNode(node, counts) {
    counts.total += 1;
    const hasEmbedding = Array.isArray(node?.embedding)
      ? node.embedding.length > 0
      : Boolean(node?.embedding && typeof node.embedding.length === 'number' && node.embedding.length > 0);
    if (hasEmbedding || node?.embedding_status === 'embedded') {
      counts.embedded += 1;
    } else {
      counts.missing += 1;
    }
  }

  async function readAgentMemorySummary(agentName) {
    if (!agentName) {
      return { agent: null, total: 0, embedded: 0, missing: 0, source: 'none' };
    }
    const logsDir = path.join(home23Root, 'instances', agentName, 'logs');
    const counts = { agent: agentName, total: 0, embedded: 0, missing: 0, source: 'none' };

    try {
      if (sidecarsExist(logsDir)) {
        await readJsonlGz(nodesPath(logsDir), (node) => {
          countMemoryNode(node, counts);
        });
        counts.source = 'sidecar';
        return counts;
      }

      const statePath = path.join(logsDir, 'state.json');
      const state = await StateCompression.loadCompressed(statePath);
      const nodes = Array.isArray(state?.memory?.nodes) ? state.memory.nodes : [];
      for (const node of nodes) countMemoryNode(node, counts);
      counts.source = nodes.length ? 'state' : 'none';
      return counts;
    } catch (error) {
      return { ...counts, source: 'unavailable', error: error.message };
    }
  }

  function getSimpleModelPlan(agentName) {
    const homeConfig = loadHomeConfig();
    const agentConfig = loadAgentConfig(agentName);
    const chat = agentConfig.chat || {};
    const provider = chat.defaultProvider || chat.provider || homeConfig.chat?.defaultProvider || '';
    const model = chat.defaultModel || chat.model || homeConfig.chat?.defaultModel || '';
    const aliases = homeConfig.models?.aliases || {};
    return {
      chat: { provider, model },
      query: {
        provider: agentConfig.query?.defaultProvider || homeConfig.query?.defaultProvider || provider,
        model: agentConfig.query?.defaultModel || homeConfig.query?.defaultModel || model,
      },
      internal: agentConfig.engine || {},
      aliases,
    };
  }

  function normalizeXResearchSettings(stored = {}) {
    const defaults = stored.defaults && typeof stored.defaults === 'object' ? stored.defaults : {};
    return {
      defaults: {
        quick: defaults.quick === true,
        saveMarkdown: defaults.saveMarkdown !== false,
      },
    };
  }

  const IMAGE_PROVIDER_CATALOG = Object.freeze({
    openai: {
      displayName: 'OpenAI',
      models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'],
    },
    minimax: {
      displayName: 'MiniMax',
      models: ['image-01'],
    },
    xai: {
      displayName: 'xAI',
      models: ['grok-imagine-image', 'grok-imagine-image-pro'],
    },
  });

  function normalizeImageGenerationSettings(stored = {}) {
    const fallbackProvider = 'openai';
    const provider = typeof stored.provider === 'string' && IMAGE_PROVIDER_CATALOG[stored.provider]
      ? stored.provider
      : fallbackProvider;
    const models = IMAGE_PROVIDER_CATALOG[provider].models;
    const fallbackModel = models[0];
    const model = typeof stored.model === 'string' && models.includes(stored.model)
      ? stored.model
      : fallbackModel;
    return { provider, model };
  }

  async function importSkillLoader() {
    return import(pathToFileURL(path.join(home23Root, 'workspace', 'skills', 'skill-loader.js')).href);
  }

  router.get('/providers', (req, res) => {
    const secrets = loadSecrets();
    const providers = secrets.providers || {};
    const masked = {};
    for (const [name, config] of Object.entries(providers)) {
      masked[name] = {
        hasKey: !!config?.apiKey,
        maskedKey: maskKey(config?.apiKey || ''),
      };
    }
    res.json({ providers: masked });
  });

  router.put('/providers', async (req, res) => {
    const { providers } = req.body;
    if (!providers || typeof providers !== 'object') {
      return res.status(400).json({ error: 'providers object required' });
    }

    let targets;
    try {
      await updateSettingsSecrets(home23Root, (secrets) => {
        if (!secrets.providers || typeof secrets.providers !== 'object') secrets.providers = {};
        let changed = false;
        for (const [name, config] of Object.entries(providers)) {
          if (config.apiKey && config.apiKey.trim()) {
            if (!secrets.providers[name] || typeof secrets.providers[name] !== 'object') {
              secrets.providers[name] = {};
            }
            const nextKey = config.apiKey.trim();
            if (secrets.providers[name].apiKey !== nextKey) {
              secrets.providers[name].apiKey = nextKey;
              changed = true;
            }
          }
        }
        return { changed };
      });
      seedCosmo23Config();
      regenerateEcosystem();
      regenerateEvobrewConfig();
      targets = [
        ...discoverAgents().flatMap(name => [`home23-${name}`, `home23-${name}-harness`]),
        'home23-evobrew',
        'home23-cosmo23',
      ];
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }

    try {
      const restartedTargets = await restartOnlineProcessesWithSharedLock(targets);
      return res.json({ ok: true, restarted: restartedTargets.length > 0, targets: restartedTargets });
    } catch (err) {
      return res.json({ ok: true, restarted: false, warn: err.message });
    }
  });

  router.post('/providers/:name/test', async (req, res) => {
    const secrets = loadSecrets();
    const providerName = req.params.name;
    const apiKey = String(req.body?.apiKey || '').trim() || secrets.providers?.[providerName]?.apiKey;

    if (!apiKey) {
      return res.json({ ok: false, error: 'No API key configured' });
    }

    const tests = {
      'ollama-cloud': {
        url: 'https://ollama.com/v1/models',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      },
      'anthropic': {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      },
      'minimax': {
        url: 'https://api.minimax.io/anthropic/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          max_tokens: 1,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        }),
      },
      'openai': {
        url: 'https://api.openai.com/v1/models',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      },
      'xai': {
        url: 'https://api.x.ai/v1/models',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      },
    };
    const testConfig = tests[providerName];
    if (!testConfig) {
      return res.json({ ok: false, error: 'Unknown provider' });
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(testConfig.url, {
        method: testConfig.method || 'GET',
        headers: testConfig.headers,
        body: testConfig.body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      res.json({ ok: response.ok, status: response.status });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ── Task 3: Agents API ──

  function getAgentStatus(agentName) {
    try {
      const { execSync } = require('child_process');
      const output = execSync('pm2 jlist', { encoding: 'utf8', stdio: 'pipe' });
      const procs = JSON.parse(output);
      const expectedNames = new Set([
        `home23-${agentName}`,
        `home23-${agentName}-dash`,
        `home23-${agentName}-feeder`,
        `home23-${agentName}-harness`,
      ]);
      const agentProcs = procs.filter(p => expectedNames.has(p.name));
      if (agentProcs.length === 0) return 'stopped';
      const allOnline = agentProcs.every(p => p.pm2_env?.status === 'online');
      const anyOnline = agentProcs.some(p => p.pm2_env?.status === 'online');
      if (allOnline) return 'running';
      if (anyOnline) return 'partial';
      return 'stopped';
    } catch {
      return 'unknown';
    }
  }

  router.get('/agents', (req, res) => {
    const primary = getPrimaryAgent({ autoHeal: true });
    const currentAgent = getCurrentDashboardAgent();
    const secretsForDisplay = loadYaml(path.join(home23Root, 'config', 'secrets.yaml'));
    const agents = discoverAgents().map(name => {
      const config = loadYaml(path.join(home23Root, 'instances', name, 'config.yaml'));
      const agentSec = secretsForDisplay.agents?.[name] || {};
      return {
        name,
        displayName: config.agent?.displayName || name,
        owner: config.agent?.owner?.name || '',
        purpose: config.agent?.purpose || '',
        timezone: config.agent?.timezone || '',
        model: config.chat?.model || config.chat?.defaultModel || '',
        provider: config.chat?.provider || config.chat?.defaultProvider || '',
        ports: config.ports || {},
        telegramId: config.agent?.owner?.telegramId || '',
        status: getAgentStatus(name),
        isPrimary: name === primary,
        channels: {
          telegram: { enabled: !!config.channels?.telegram?.enabled },
          discord: {
            enabled: !!config.channels?.discord?.enabled,
            hasToken: !!agentSec.discord?.token,
            guilds: config.channels?.discord?.guilds || {},
          },
        },
        hasTelegram: !!config.channels?.telegram?.enabled,
      };
    });
    // Primary agent first
    agents.sort((a, b) => ((b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)) || a.name.localeCompare(b.name));
    res.json({ agents, primaryAgent: primary, currentAgent });
  });

  function findNextPorts() {
    const instancesDir = path.join(home23Root, 'instances');
    if (!fs.existsSync(instancesDir)) return { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 };
    let maxBase = 4991;
    for (const name of discoverAgents()) {
      const config = loadYaml(path.join(instancesDir, name, 'config.yaml'));
      const enginePort = config.ports?.engine || 0;
      if (enginePort > maxBase) maxBase = enginePort;
    }
    const base = Math.ceil((maxBase + 1) / 10) * 10 + 1;
    return { engine: base, dashboard: base + 1, mcp: base + 2, bridge: base + 3 };
  }

  function loadTemplate(filename) {
    const templatePath = path.join(home23Root, 'cli', 'templates', filename);
    if (!fs.existsSync(templatePath)) return `# ${filename.replace('.md', '')}\n`;
    return fs.readFileSync(templatePath, 'utf8');
  }

  function renderTemplate(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return result;
  }

  function defaultPurpose(ownerName) {
    const owner = ownerName && ownerName !== 'owner' ? ownerName : 'me';
    return `Help ${owner} organize work, remember important context, and keep projects moving.`;
  }

  function expandUserPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    return raw;
  }

  function pathLabel(filePath, seenLabels) {
    const base = path.basename(filePath)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'project';
    let label = base;
    let suffix = 2;
    while (seenLabels.has(label)) {
      label = `${base}-${suffix}`;
      suffix += 1;
    }
    seenLabels.add(label);
    return label;
  }

  function parseIngestPaths(input) {
    const rawItems = Array.isArray(input)
      ? input
      : String(input || '').split(/[\n,;]/);
    const seenPaths = new Set();
    const seenLabels = new Set();
    const out = [];
    for (const item of rawItems) {
      const value = typeof item === 'string' ? item : item?.path;
      const expanded = expandUserPath(value);
      if (!expanded) continue;
      const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(home23Root, expanded);
      if (seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const explicitLabel = typeof item === 'object' && item?.label ? String(item.label).trim() : '';
      const label = explicitLabel || pathLabel(resolved, seenLabels);
      out.push({ path: resolved, label });
    }
    return out;
  }

  function projectSurface(today, ingestPaths = []) {
    if (!ingestPaths.length) {
      return `# Active Projects\n\n_No projects tracked yet. Add project folders through Settings -> Feeder or rerun setup when you are ready._\n\n_Curator-maintained. Last updated: ${today}._\n`;
    }
    const rows = ingestPaths.map(item => `- ${item.label}: ${item.path}`).join('\n');
    return `# Active Projects\n\n## Starter Project Folders\n${rows}\n\nThese folders are watched by the Document Feeder and will be ingested into the agent's brain as files change.\n\n_Curator-maintained. Last updated: ${today}._\n`;
  }

  function parsePersonalFacts(input) {
    return String(input || '')
      .split(/\n/)
      .map(line => line.replace(/^-+\s*/, '').trim())
      .filter(Boolean);
  }

  function personalSurface(ownerName, personalFacts = []) {
    const facts = Array.isArray(personalFacts) ? personalFacts : parsePersonalFacts(personalFacts);
    const factBlock = facts.length
      ? `\n## Up-Front Context\n${facts.map(line => `- ${line}`).join('\n')}\n`
      : '\n## Up-Front Context\n_No additional personal context provided during setup._\n';
    return `# Personal Context — ${ownerName}\n\n## Profile\n- Owner: ${ownerName}\n${factBlock}\n_Personal memory. Surface only on direct relevance. Curator-maintained._\n`;
  }

  function writeMissionFile(instanceDir, vars) {
    const template = loadTemplate('MISSION.md');
    const content = renderTemplate(template, vars);
    fs.mkdirSync(path.join(instanceDir, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'workspace', 'MISSION.md'), content, 'utf8');
  }

  function regenerateEcosystem() {
    const { execSync } = require('child_process');
    execSync(`node --input-type=module -e "
      import { generateEcosystem } from './cli/lib/generate-ecosystem.js';
      generateEcosystem('.');
    "`, { cwd: home23Root, stdio: 'pipe', timeout: 10000 });
  }

  function regenerateEvobrewConfig() {
    const { execSync } = require('child_process');
    execSync(`node --input-type=module -e "
      import { writeEvobrewConfig } from './cli/lib/evobrew-config.js';
      writeEvobrewConfig('.');
    "`, { cwd: home23Root, stdio: 'pipe', timeout: 10000 });
  }

  router.post('/agents', async (req, res) => {
    const {
      name,
      displayName,
      ownerName,
      ownerTelegramId,
      timezone,
      botToken,
      model,
      provider,
      purpose,
      personalFacts,
      ingestPaths,
    } = req.body;

    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase alphanumeric with hyphens' });
    }

    const instanceDir = path.join(home23Root, 'instances', name);
    if (fs.existsSync(instanceDir)) {
      return res.status(409).json({ error: `Agent "${name}" already exists` });
    }
    const providerReady = assertSelectedChatProviderReady(provider, model);
    if (!providerReady.ok) {
      return res.status(400).json({ error: providerReady.error });
    }

    // Determine if this is the first agent (will be primary)
    const isFirst = discoverAgents().length === 0;

    const ports = findNextPorts();
    const resolvedOwnerName = String(ownerName || '').trim() || 'owner';
    const resolvedDisplayName = String(displayName || '').trim() || name.charAt(0).toUpperCase() + name.slice(1);
    const resolvedPurpose = String(purpose || '').trim() || defaultPurpose(resolvedOwnerName);
    const resolvedPersonalFacts = parsePersonalFacts(personalFacts);
    const starterIngestPaths = parseIngestPaths(ingestPaths);

    for (const dir of ['workspace', 'workspace/scripts', 'brain', 'conversations', 'conversations/sessions', 'logs', 'cron-runs']) {
      fs.mkdirSync(path.join(instanceDir, dir), { recursive: true });
    }

    const agentConfig = buildAgentConfig({
      name,
      displayName: resolvedDisplayName,
      ownerName: resolvedOwnerName,
      ownerTelegramId,
      personalFacts: resolvedPersonalFacts,
      timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
      ports,
      purpose: resolvedPurpose,
      home23Version: getHome23Version(),
      provider,
      model,
      instanceDir,
      ingestPaths: starterIngestPaths,
      botToken,
    });
    saveYaml(path.join(instanceDir, 'config.yaml'), agentConfig);

    const feederConfig = buildFeederConfig(name);
    saveYaml(path.join(instanceDir, 'feeder.yaml'), feederConfig);

    const templateVars = {
      displayName: resolvedDisplayName,
      name,
      ownerName: resolvedOwnerName,
      purpose: resolvedPurpose,
    };
    for (const file of ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'MEMORY.md', 'LEARNINGS.md', 'GOOD_LIFE.md', 'COSMO_RESEARCH.md', 'NOW.md', 'PLAYBOOK.md']) {
      const template = loadTemplate(file);
      const content = renderTemplate(template, templateVars);
      fs.writeFileSync(path.join(instanceDir, 'workspace', file), content, 'utf8');
    }

    // Seed domain surfaces for Situational Awareness Engine (Step 20)
    const today = new Date().toISOString().split('T')[0];
    const surfaces = {
      'TOPOLOGY.md': `# House Topology\n\n_No services registered yet. The curator cycle will populate this as the agent learns about the house._\n\n_Last verified: ${today}. Source: initial setup._\n`,
      'PROJECTS.md': projectSurface(today, starterIngestPaths),
      'PERSONAL.md': personalSurface(resolvedOwnerName, resolvedPersonalFacts),
      'DOCTRINE.md': `# Doctrine — How We Work\n\n## Conventions\n- Engine is JS. Harness is TS. Two languages, one system.\n- NEVER pm2 delete/stop all — scope commands to specific process names.\n\n_Curator-maintained. Includes boundaries and operating constraints._\n`,
      'RECENT.md': `# Recent Activity (Last 48 Hours)\n\n## ${today}\n\n### Agent created\n- ${resolvedDisplayName} initialized with Home23\n- Purpose: ${resolvedPurpose}\n- Starter ingestion paths: ${starterIngestPaths.length || 0}\n- Situational awareness engine active\n\n_Auto-generated. Entries older than 48h drop from assembly loading._\n`,
    };

    for (const [file, content] of Object.entries(surfaces)) {
      fs.writeFileSync(path.join(instanceDir, 'workspace', file), content, 'utf8');
    }

    // Seed empty brain data files for Step 20
    fs.writeFileSync(path.join(instanceDir, 'brain', 'memory-objects.json'), JSON.stringify({ objects: [] }, null, 2));
    fs.writeFileSync(path.join(instanceDir, 'brain', 'problem-threads.json'), JSON.stringify({ threads: [] }, null, 2));
    fs.writeFileSync(path.join(instanceDir, 'brain', 'trigger-index.json'), JSON.stringify({ triggers: [] }, null, 2));

    // Save bot token to secrets if provided
    if (botToken) {
      try {
        await updateSettingsSecrets(home23Root, (secrets) => {
          if (!secrets.agents || typeof secrets.agents !== 'object') secrets.agents = {};
          if (!secrets.agents[name] || typeof secrets.agents[name] !== 'object') secrets.agents[name] = {};
          const previous = secrets.agents[name].telegram?.botToken || '';
          if (previous === botToken) return { changed: false };
          secrets.agents[name].telegram = {
            ...(secrets.agents[name].telegram || {}),
            botToken,
          };
          return { changed: true };
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    // Set as primary agent if first
    if (isFirst) {
      setPrimaryAgent(name);
    }

    regenerateEcosystem();

    res.json({
      ok: true,
      agent: {
        name,
        displayName: resolvedDisplayName,
        purpose: resolvedPurpose,
        personalFacts: resolvedPersonalFacts,
        ingestPaths: starterIngestPaths,
        ports,
        isPrimary: isFirst,
      },
    });
  });

  router.put('/agents/:name', async (req, res) => {
    const agentName = req.params.name;
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Agent "${agentName}" not found` });
    }

    const config = loadYaml(configPath);
    if (!config.agent) config.agent = {};
    if (!config.agent.owner) config.agent.owner = {};
    const { displayName, ownerName, ownerTelegramId, timezone, model, provider, purpose } = req.body;
    const identityChanged = displayName !== undefined || ownerName !== undefined || purpose !== undefined;

    if (displayName !== undefined) config.agent.displayName = displayName;
    if (ownerName !== undefined) config.agent.owner.name = ownerName;
    if (ownerTelegramId !== undefined) config.agent.owner.telegramId = ownerTelegramId;
    if (purpose !== undefined) {
      const nextPurpose = String(purpose || '').trim();
      config.agent.purpose = nextPurpose || defaultPurpose(config.agent.owner?.name || 'owner');
    }
    if (timezone !== undefined) {
      config.agent.timezone = timezone;
      if (config.scheduler) config.scheduler.timezone = timezone;
    }
    if (model !== undefined) {
      config.chat.model = model; config.chat.defaultModel = model;
    }
    if (provider !== undefined) { config.chat.provider = provider; config.chat.defaultProvider = provider; }

    // Channel updates
    const { telegram, discord } = req.body;
    if (telegram !== undefined) {
      if (!config.channels) config.channels = {};
      if (telegram.enabled !== undefined) {
        if (!config.channels.telegram) config.channels.telegram = {};
        config.channels.telegram.enabled = telegram.enabled;
        // Set defaults if enabling for the first time
        if (telegram.enabled && !config.channels.telegram.streaming) {
          config.channels.telegram.streaming = 'partial';
          config.channels.telegram.dmPolicy = 'open';
          config.channels.telegram.groupPolicy = 'restricted';
          config.channels.telegram.groups = {};
          config.channels.telegram.ackReaction = true;
        }
      }
    }
    if (discord !== undefined) {
      if (!config.channels) config.channels = {};
      if (!config.channels.discord) config.channels.discord = {};
      if (discord.enabled !== undefined) {
        config.channels.discord.enabled = discord.enabled;
        if (discord.enabled) {
          if (!config.channels.discord.streaming) config.channels.discord.streaming = 'partial';
          if (!config.channels.discord.groupPolicy) config.channels.discord.groupPolicy = 'restricted';
          if (config.channels.discord.threadBindings === undefined) config.channels.discord.threadBindings = true;
        }
      }
      if (discord.guilds !== undefined) {
        config.channels.discord.guilds = discord.guilds || {};
      } else if (!config.channels.discord.guilds) {
        config.channels.discord.guilds = {};
      }
    }

    const telegramToken = telegram?.botToken;
    const discordToken = discord?.token;
    if (telegramToken || discordToken) {
      try {
        await updateSettingsSecrets(home23Root, (secrets) => {
          if (!secrets.agents || typeof secrets.agents !== 'object') secrets.agents = {};
          if (!secrets.agents[agentName] || typeof secrets.agents[agentName] !== 'object') {
            secrets.agents[agentName] = {};
          }
          const agentSecrets = secrets.agents[agentName];
          let changed = false;
          if (telegramToken && agentSecrets.telegram?.botToken !== telegramToken) {
            agentSecrets.telegram = { ...(agentSecrets.telegram || {}), botToken: telegramToken };
            changed = true;
          }
          if (discordToken && agentSecrets.discord?.token !== discordToken) {
            agentSecrets.discord = { ...(agentSecrets.discord || {}), token: discordToken };
            changed = true;
          }
          return { changed };
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    saveYaml(configPath, config);
    if (identityChanged) {
      writeMissionFile(path.dirname(configPath), {
        displayName: config.agent.displayName || agentName,
        name: agentName,
        ownerName: config.agent.owner?.name || 'owner',
        purpose: config.agent.purpose || defaultPurpose(config.agent.owner?.name || 'owner'),
      });
    }
    regenerateEcosystem();

    // Sync model change to harness's persisted file + restart harness
    if (model !== undefined || provider !== undefined) {
      const m = model || config.chat?.defaultModel || config.chat?.model;
      const p = provider || config.chat?.defaultProvider || config.chat?.provider;
      // Write to all locations the harness checks
      const convDir = path.join(home23Root, 'instances', agentName, 'conversations');
      const brainDir = path.join(home23Root, 'instances', agentName, 'brain');
      const modelJson = JSON.stringify({ model: m, provider: p });
      for (const dir of [convDir, brainDir]) {
        try { fs.writeFileSync(path.join(dir, 'default-model.json'), modelJson); } catch { /* ok */ }
      }
      // Chat model change is harness-scoped. Do NOT touch the engine's
      // cognitive routing (modelAssignments) or restart the engine —
      // engine cognitive models are managed via Settings → Models.
      try {
        recycleManagedProcess(`home23-${agentName}-harness`);
      } catch { /* non-fatal */ }
      regenerateEvobrewConfig();
    }

    res.json({ ok: true });
  });

  router.post('/agents/:name/primary', (req, res) => {
    const agentName = req.params.name;
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Agent "${agentName}" not found` });
    }

    setPrimaryAgent(agentName);
    regenerateEcosystem();
    regenerateEvobrewConfig();

    res.json({ ok: true, primaryAgent: agentName });
  });

  router.delete('/agents/:name', async (req, res) => {
    const agentName = req.params.name;
    if (agentName === getPrimaryAgent()) {
      return res.status(403).json({ error: 'Cannot delete the primary agent' });
    }
    const instanceDir = path.join(home23Root, 'instances', agentName);
    if (!fs.existsSync(instanceDir)) {
      return res.status(404).json({ error: `Agent "${agentName}" not found` });
    }

    try {
      const { execSync } = require('child_process');
      const names = [`home23-${agentName}`, `home23-${agentName}-dash`, `home23-${agentName}-harness`];
      for (const n of names) {
        try { execSync(`pm2 stop ${n}`, { env: cleanPm2Env(), stdio: 'pipe' }); } catch { /* not running */ }
        try { execSync(`pm2 delete ${n}`, { env: cleanPm2Env(), stdio: 'pipe' }); } catch { /* not in list */ }
      }
    } catch { /* pm2 not available */ }

    fs.rmSync(instanceDir, { recursive: true, force: true });

    try {
      await updateSettingsSecrets(home23Root, (secrets) => {
        if (!secrets.agents?.[agentName]) return { changed: false };
        delete secrets.agents[agentName];
        return { changed: true };
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }

    regenerateEcosystem();
    res.json({ ok: true });
  });

  router.post('/agents/:name/start', (req, res) => {
    const agentName = req.params.name;
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Agent "${agentName}" not found` });
    }

    try {
      const { execSync } = require('child_process');
      const ecosystemPath = path.join(home23Root, 'ecosystem.config.cjs');
      const names = [`home23-${agentName}`, `home23-${agentName}-dash`, `home23-${agentName}-harness`];
      execSync(`pm2 start ${ecosystemPath} --only ${names.join(',')} --update-env --silent`, { cwd: home23Root, env: cleanPm2Env(), stdio: 'pipe', timeout: 30000 });
      res.json({ ok: true, status: 'running' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/agents/:name/restart-engine', (req, res) => {
    const agentName = req.params.name;
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Agent "${agentName}" not found` });
    }

    try {
      const restarted = recycleManagedProcess(`home23-${agentName}`);
      res.json({ ok: true, restarted: restarted ? `home23-${agentName}` : null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Restart just the harness — used after channel/model/token changes.
  // Doing this via the /stop+/start flow kills the dashboard serving the request,
  // so we shell out pm2 in detached mode and target harness only.
  router.post('/agents/:name/restart-harness', (req, res) => {
    const agentName = req.params.name;
    const harnessProc = `home23-${agentName}-harness`;
    try {
      const restarted = recycleManagedProcess(harnessProc);
      res.json({ ok: true, restarted: restarted ? harnessProc : null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/agents/:name/stop', (req, res) => {
    const agentName = req.params.name;
    try {
      const { execSync } = require('child_process');
      // Batch the agent triplet into one pm2 stop call — pm2 stops them in
      // parallel internally, so the engine's ~1.6s kill_timeout is paid once,
      // not four times in series. Sequential stops used to take 6-12s.
      const names = [`home23-${agentName}`, `home23-${agentName}-dash`, `home23-${agentName}-harness`];
      try {
        execSync(`pm2 stop ${names.join(' ')}`, { env: cleanPm2Env(), stdio: 'pipe', timeout: 15000 });
      } catch { /* some processes may not be online — pm2 non-zero is fine */ }
      res.json({ ok: true, status: 'stopped' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── COSMO 2.3 process management ──

  router.get('/cosmo23/status', (req, res) => {
    try {
      const { execSync } = require('child_process');
      const jlist = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 }));
      const proc = jlist.find(p => p.name === 'home23-cosmo23');
      if (!proc) return res.json({ running: false, reason: 'not_in_pm2' });
      res.json({ running: proc.pm2_env?.status === 'online', pid: proc.pid, status: proc.pm2_env?.status });
    } catch (err) {
      res.json({ running: false, reason: 'pm2_error', error: err.message });
    }
  });

  router.post('/cosmo23/restart', async (req, res) => {
    try {
      // Seed config before starting
      const { seedCosmo23Config } = await import(path.join(home23Root, 'cli', 'lib', 'cosmo23-config.js'));
      await seedCosmo23Config(home23Root);
      const { pathToFileURL } = require('url');
      const sharedStart = await import(pathToFileURL(
        path.join(home23Root, 'cli', 'lib', 'shared-service-start.js')
      ).href);
      const cosmoService = sharedStart.SHARED_SERVICES.find(
        service => service.name === 'home23-cosmo23'
      );
      if (!cosmoService) throw new Error('COSMO shared-service definition is missing');
      await sharedStart.coordinateSharedServiceStartup({
        home23Root,
        services: [cosmoService],
        restartOnline: true,
      });
      res.json({ ok: true, status: 'started' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Task 4: Models + System API ──

  router.get('/models', (req, res) => {
    const homeConfig = loadHomeConfig();
    const targetAgent = resolveRequestedAgent(req.query.agent);
    const agentConfig = loadAgentConfig(targetAgent);
    const agentChat = agentConfig.chat || {};
    const effectiveAgentChat = {
      defaultProvider: agentChat.defaultProvider || agentChat.provider || homeConfig.chat?.defaultProvider || '',
      defaultModel: agentChat.defaultModel || agentChat.model || homeConfig.chat?.defaultModel || '',
    };
    res.json({
      agent: targetAgent,
      currentAgent: getCurrentDashboardAgent(),
      primaryAgent: getPrimaryAgent({ autoHeal: true }),
      chat: effectiveAgentChat,
      sharedChatDefaults: homeConfig.chat || {},
      aliases: homeConfig.models?.aliases || {},
      imageGeneration: normalizeImageGenerationSettings(homeConfig.media?.imageGeneration || {}),
      imageProviders: IMAGE_PROVIDER_CATALOG,
      providers: Object.fromEntries(
        Object.entries(homeConfig.providers || {}).map(([name, cfg]) => [name, { defaultModels: cfg.defaultModels || [] }])
      ),
      engineRoles: agentConfig.engine || {},
    });
  });

  router.put('/models', async (req, res) => {
    const { agent, chat, aliases, providerModels, engineRoles, imageGeneration } = req.body || {};
    const configPath = getHomeConfigPath();
    const previousHomeConfig = loadYaml(configPath);
    const homeConfig = cloneConfig(previousHomeConfig);
    const targetAgent = resolveRequestedAgent(agent);
    const roleModels = engineRoles && typeof engineRoles === 'object' ? engineRoles : {};
    const chatChanged = !!chat;
    const engineRolesChanged = engineRoles !== undefined;
    const catalogChanged = !!providerModels;
    const authorityChanged = chatChanged || catalogChanged;
    let restartedHarness = false;
    let restartedAgent = false;
    let homeConfigDirty = false;
    let agentConfigPath = null;
    let previousAgentConfig = null;
    let agentConfig = null;
    let runtimeRefresh = null;
    let authorityFilesWritten = false;
    let authorityRefreshAttempted = false;
    let authorityRolledBack = false;

    const rollbackAuthorityFiles = () => {
      if (authorityRolledBack) return;
      authorityRolledBack = true;
      if (agentConfigPath && previousAgentConfig) saveYaml(agentConfigPath, previousAgentConfig);
      if (homeConfigDirty) saveYaml(configPath, previousHomeConfig);
    };

    try {
      if (chatChanged || engineRolesChanged) {
        if (!targetAgent) {
          return res.status(400).json({ ok: false, error: 'No target agent selected' });
        }
        agentConfigPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
        if (!fs.existsSync(agentConfigPath)) {
          return res.status(404).json({ ok: false, error: `Agent "${targetAgent}" not found` });
        }
        previousAgentConfig = loadYaml(agentConfigPath);
        agentConfig = cloneConfig(previousAgentConfig);
        if (!agentConfig.chat) agentConfig.chat = {};
        if (chatChanged && chat?.defaultProvider !== undefined) {
          agentConfig.chat.provider = chat.defaultProvider;
          agentConfig.chat.defaultProvider = chat.defaultProvider;
        }
        if (chatChanged && chat?.defaultModel !== undefined) {
          agentConfig.chat.model = chat.defaultModel;
          agentConfig.chat.defaultModel = chat.defaultModel;
        }

        if (engineRolesChanged) {
          if (!agentConfig.engine) agentConfig.engine = {};
          for (const role of ['thought', 'consolidation', 'dreaming', 'query']) {
            if (roleModels[role]) {
              agentConfig.engine[role] = roleModels[role];
            } else {
              delete agentConfig.engine[role];
            }
          }
        }
      }

      if (aliases !== undefined) {
        if (!homeConfig.models) homeConfig.models = {};
        homeConfig.models.aliases = aliases;
        homeConfigDirty = true;
      }
      if (catalogChanged) {
        if (!homeConfig.providers) homeConfig.providers = {};
        for (const [provName, models] of Object.entries(providerModels)) {
          if (!homeConfig.providers[provName]) homeConfig.providers[provName] = {};
          homeConfig.providers[provName].defaultModels = models;
        }
        homeConfigDirty = true;
      }
      if (imageGeneration && typeof imageGeneration === 'object') {
        if (!homeConfig.media) homeConfig.media = {};
        homeConfig.media.imageGeneration = normalizeImageGenerationSettings(imageGeneration);
        homeConfigDirty = true;
      }

      if (authorityChanged) {
        const agents = discoverAgents();
        for (const agentName of agents) {
          const prospectiveAgent = agentName === targetAgent && agentConfig
            ? agentConfig
            : loadAgentConfig(agentName);
          validateModelAuthority(homeConfig, prospectiveAgent);
        }
      }

      if (agentConfigPath && agentConfig) {
        saveYaml(agentConfigPath, agentConfig);
        if (authorityChanged) authorityFilesWritten = true;
      }
      if (homeConfigDirty) {
        saveYaml(configPath, homeConfig);
        if (authorityChanged) authorityFilesWritten = true;
      }

      if (authorityChanged) {
        const primaryAgent = getPrimaryAgent({ autoHeal: false });
        authorityRefreshAttempted = true;
        runtimeRefresh = await refreshModelAuthority({
          agent: targetAgent || primaryAgent,
          primaryAgent,
          globalCatalogChanged: catalogChanged,
          affectsManagedCosmo: catalogChanged || targetAgent === primaryAgent,
          reason: 'model-settings-update',
          rollback: rollbackAuthorityFiles,
        });
      }

      if (homeConfigDirty) regenerateEvobrewConfig();

      if (chatChanged) {
        const effectiveProvider = agentConfig.chat.defaultProvider || agentConfig.chat.provider;
        const effectiveModel = agentConfig.chat.defaultModel || agentConfig.chat.model;
        syncAgentDefaultModelFiles(targetAgent, effectiveProvider, effectiveModel);
        try {
          restartedHarness = recycleModelProcess(`home23-${targetAgent}-harness`);
        } catch (err) {
          console.error(`[Settings] Failed to restart ${targetAgent}-harness after chat model changes:`, err.message);
        }
      }

      if (chatChanged || engineRolesChanged) {
        try {
          restartedAgent = recycleModelProcess(`home23-${targetAgent}`);
        } catch (err) {
          console.error(`[Settings] Failed to restart ${targetAgent} after model changes:`, err.message);
        }
      }

      res.json({
        ok: true,
        agent: targetAgent,
        restartedAgent,
        restartedHarness,
        runtimeRefresh,
      });
    } catch (err) {
      if (authorityChanged && authorityFilesWritten && !authorityRolledBack) {
        try {
          rollbackAuthorityFiles();
          if (!authorityRefreshAttempted) {
            await seedModelAuthority({
              home23Root,
              agent: targetAgent || getPrimaryAgent({ autoHeal: false }),
              reason: 'model-settings-write-rollback',
            });
          }
        } catch (rollbackError) {
          console.error('[Settings] Failed to roll back model settings transaction:', rollbackError.message);
        }
      }
      const status = err?.code === 'model_pair_invalid' || err?.code === 'model_catalog_invalid'
        ? 400
        : 500;
      res.status(status).json({ ok: false, code: err?.code || 'settings_update_failed', error: err.message });
    }
  });

  // ── Query (Query-tab defaults) ──
  //
  // Stored under home.yaml:query. Read by the Query tab and by Settings.

  router.get('/query', (req, res) => {
    const homeConfig = loadHomeConfig();
    const targetAgent = resolveRequestedAgent(req.query.agent);
    const agentConfig = loadAgentConfig(targetAgent);
    const q = agentConfig.query || homeConfig.query || {};
    const agentChat = agentConfig.chat || homeConfig.chat || {};
    res.json({
      agent: targetAgent,
      defaultModel: q.defaultModel || '',
      defaultProvider: q.defaultProvider || q.provider || agentChat.defaultProvider || agentChat.provider || '',
      defaultMode: q.defaultMode || 'full',
      enablePGSByDefault: !!q.enablePGSByDefault,
      pgsSweepModel: q.pgsSweepModel || '',
      pgsSweepProvider: q.pgsSweepProvider || '',
      pgsSynthModel: q.pgsSynthModel || '',
      pgsSynthProvider: q.pgsSynthProvider || q.defaultProvider || q.provider || agentChat.defaultProvider || agentChat.provider || '',
      pgsDepth: typeof q.pgsDepth === 'number' ? q.pgsDepth : 0.25,
    });
  });

  router.put('/query', async (req, res) => {
    try {
      const targetAgent = resolveRequestedAgent(req.body?.agent);
      if (!targetAgent) {
        return res.status(400).json({ ok: false, error: 'No target agent selected' });
      }
      const configPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
      const previousAgentConfig = loadYaml(configPath);
      const agentConfig = cloneConfig(previousAgentConfig);
      if (!agentConfig.query) agentConfig.query = {};
      const b = req.body || {};
      if (typeof b.defaultModel === 'string') agentConfig.query.defaultModel = b.defaultModel;
      if (typeof b.defaultProvider === 'string') agentConfig.query.defaultProvider = b.defaultProvider;
      if (typeof b.defaultMode === 'string') agentConfig.query.defaultMode = b.defaultMode;
      if (typeof b.enablePGSByDefault === 'boolean') agentConfig.query.enablePGSByDefault = b.enablePGSByDefault;
      if (typeof b.pgsSweepModel === 'string') agentConfig.query.pgsSweepModel = b.pgsSweepModel;
      if (typeof b.pgsSweepProvider === 'string') agentConfig.query.pgsSweepProvider = b.pgsSweepProvider;
      if (typeof b.pgsSynthModel === 'string') agentConfig.query.pgsSynthModel = b.pgsSynthModel;
      if (typeof b.pgsSynthProvider === 'string') agentConfig.query.pgsSynthProvider = b.pgsSynthProvider;
      if (typeof b.pgsDepth === 'number') agentConfig.query.pgsDepth = b.pgsDepth;

      const homeConfig = loadHomeConfig();
      validateModelAuthority(homeConfig, agentConfig);
      saveYaml(configPath, agentConfig);
      const primaryAgent = getPrimaryAgent({ autoHeal: false });
      const runtimeRefresh = await refreshModelAuthority({
        agent: targetAgent,
        primaryAgent,
        globalCatalogChanged: false,
        affectsManagedCosmo: targetAgent === primaryAgent,
        reason: 'query-settings-update',
        rollback: () => saveYaml(configPath, previousAgentConfig),
      });
      res.json({ ok: true, agent: targetAgent, runtimeRefresh });
    } catch (err) {
      const status = err?.code === 'model_pair_invalid' || err?.code === 'model_catalog_invalid'
        ? 400
        : 500;
      res.status(status).json({ ok: false, code: err?.code || 'settings_update_failed', error: err.message });
    }
  });

  // ── Model Assignments (per-slot cognitive routing) ──

  router.get('/model-assignments', (req, res) => {
    const homeConfig = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    const baseEnginePath = path.join(home23Root, 'configs', 'base-engine.yaml');
    const baseEngine = loadYaml(baseEnginePath);
    const baseAssignments = baseEngine.modelAssignments || {};

    const targetAgent = resolveRequestedAgent(req.query.agent);
    let instanceAssignments = {};
    if (targetAgent) {
      try {
        const agentConfig = loadYaml(path.join(home23Root, 'instances', targetAgent, 'config.yaml'));
        instanceAssignments = agentConfig.modelAssignments || {};
      } catch { /* ok */ }
    }

    // Effective assignments = base merged with instance overrides
    const effective = {};
    for (const [key, entry] of Object.entries(baseAssignments)) {
      effective[key] = {
        provider: entry?.provider || '',
        model: entry?.model || '',
        fallback: Array.isArray(entry?.fallback)
          ? entry.fallback.map(f => ({ provider: f.provider, model: f.model }))
          : [],
      };
    }
    for (const [key, entry] of Object.entries(instanceAssignments)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!effective[key]) effective[key] = { provider: '', model: '', fallback: [] };
      if (entry.provider) effective[key].provider = entry.provider;
      if (entry.model) effective[key].model = entry.model;
      if (Array.isArray(entry.fallback)) {
        effective[key].fallback = entry.fallback.map(f => ({ provider: f.provider, model: f.model }));
      }
    }

    const providers = Object.fromEntries(
      Object.entries(homeConfig.providers || {}).map(([name, cfg]) => [name, cfg.defaultModels || []])
    );

    res.json({
      agent: targetAgent,
      effective,
      instanceOverrides: instanceAssignments,
      base: baseAssignments,
      providers,
    });
  });

  router.put('/model-assignments', (req, res) => {
    const { assignments, agent } = req.body || {};
    if (!assignments || typeof assignments !== 'object') {
      return res.status(400).json({ error: 'assignments object required' });
    }

    const targetAgent = resolveRequestedAgent(agent);
    if (!targetAgent) {
      return res.status(400).json({ error: 'No target agent (and no primary configured)' });
    }

    const configPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Agent "${targetAgent}" config not found` });
    }

    const agentConfig = loadYaml(configPath);

    // Only persist keys that actually differ from base — keeps config clean
    const baseEngine = loadYaml(path.join(home23Root, 'configs', 'base-engine.yaml'));
    const base = baseEngine.modelAssignments || {};

    const overrides = {};
    for (const [key, entry] of Object.entries(assignments)) {
      if (!entry || typeof entry !== 'object') continue;
      const provider = (entry.provider || '').trim();
      const model = (entry.model || '').trim();
      if (!provider || !model) continue;
      const fallback = Array.isArray(entry.fallback)
        ? entry.fallback
            .filter(f => f && f.provider && f.model)
            .map(f => ({ provider: String(f.provider).trim(), model: String(f.model).trim() }))
        : [];

      const baseEntry = base[key];
      const baseFallback = Array.isArray(baseEntry?.fallback) ? baseEntry.fallback : [];
      const sameProviderModel = baseEntry && baseEntry.provider === provider && baseEntry.model === model;
      const sameFallback = baseFallback.length === fallback.length
        && baseFallback.every((f, i) => f.provider === fallback[i].provider && f.model === fallback[i].model);

      if (sameProviderModel && sameFallback) {
        // Matches base exactly — do not persist as an override
        continue;
      }

      const out = { provider, model };
      if (fallback.length) out.fallback = fallback;
      overrides[key] = out;
    }

    agentConfig.modelAssignments = overrides;
    saveYaml(configPath, agentConfig);

    // Restart engine so new assignments take effect
    try { recycleManagedProcess(`home23-${targetAgent}`); } catch { /* not running or pm2 unavailable — non-fatal */ }

    res.json({ ok: true, agent: targetAgent, overrideCount: Object.keys(overrides).length });
  });

  // ── Pulse Voice (Jerry's remark layer) ──

  function buildDefaultPulsePrompt({ agentLabel = 'the agent', ownerName = 'the owner' } = {}) {
    return `You are ${agentLabel}. You've just scanned what your own brain has been up to — cycles, thoughts, actions you executed, goals, sensors, the whole deal.

You're talking to ${ownerName}. ${ownerName} runs you. Talk directly, one to one.

Be cool. Be direct. Laid back by default. Turn it UP when something actually matters — a stuck loop, a failed action, a weird pattern, a win. Whimsical, weird metaphors welcome. Swear when you feel like it. You're not a customer service bot. Don't ask permission. Don't hedge.

NEVER restate raw brain state as a list. Have a take. React. Comment. If everything's boring, say so, but say it with style. If something broke, call it out. If you did something cool, be proud about it (briefly — no bragging).

2-4 sentences. No preamble. No "I noticed that" or "It appears." Just talk.`;
  }

  router.get('/pulse-voice', (req, res) => {
    // Read provider/model from the selected agent's modelAssignments.pulseVoice
    // (merged with base-engine default). Read systemPrompt from the selected
    // agent config.
    const homeConfig = loadHomeConfig();
    const baseEngine = loadYaml(path.join(home23Root, 'configs', 'base-engine.yaml'));
    const basePulse = baseEngine?.modelAssignments?.pulseVoice || {};

    const targetAgent = resolveRequestedAgent(req.query.agent);
    let instancePulse = {};
    let agentLabel = targetAgent || 'the agent';
    let ownerName = 'the owner';
    let systemPrompt = '';
    if (targetAgent) {
      try {
        const agentConfig = loadYaml(path.join(home23Root, 'instances', targetAgent, 'config.yaml'));
        instancePulse = agentConfig?.modelAssignments?.pulseVoice || {};
        agentLabel = agentConfig?.agent?.displayName || agentConfig?.agent?.name || targetAgent;
        ownerName = agentConfig?.agent?.owner?.name || ownerName;
        systemPrompt = agentConfig?.pulseVoice?.systemPrompt || '';
      } catch { /* ok */ }
    }
    const defaultPrompt = buildDefaultPulsePrompt({ agentLabel, ownerName });

    res.json({
      agent: targetAgent,
      provider: instancePulse.provider || basePulse.provider || homeConfig.chat?.defaultProvider || '',
      model: instancePulse.model || basePulse.model || homeConfig.chat?.defaultModel || '',
      systemPrompt: systemPrompt || defaultPrompt,
      defaultPrompt,
      providers: Object.fromEntries(
        Object.entries(homeConfig.providers || {}).map(([n, cfg]) => [n, cfg.defaultModels || []])
      ),
    });
  });

  router.put('/pulse-voice', (req, res) => {
    const { provider, model, systemPrompt, agent } = req.body || {};

    // Write provider/model to instance modelAssignments.pulseVoice (same
    // mechanism Cognitive Assignments uses)
    const targetAgent = resolveRequestedAgent(agent);
    if (!targetAgent) {
      return res.status(400).json({ error: 'No target agent selected' });
    }

    const configPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
    if (fs.existsSync(configPath)) {
      const agentConfig = loadYaml(configPath);
      agentConfig.modelAssignments = agentConfig.modelAssignments || {};
      if (provider && model) {
        agentConfig.modelAssignments.pulseVoice = {
          provider: String(provider).trim(),
          model: String(model).trim(),
        };
      }
      if (typeof systemPrompt === 'string') {
        agentConfig.pulseVoice = agentConfig.pulseVoice || {};
        agentConfig.pulseVoice.systemPrompt = systemPrompt;
      }
      saveYaml(configPath, agentConfig);
    }

    // Restart the agent engine so the new model + prompt take effect on the
    // next pulse tick
    try { recycleManagedProcess(`home23-${targetAgent}`); } catch { /* non-fatal */ }

    res.json({ ok: true, agent: targetAgent });
  });

  // ── Agency (autonomous action allow-list + activity log) ──

  function agencyYamlPath() {
    return path.join(home23Root, 'configs', 'action-allowlist.yaml');
  }

  router.get('/agency/allowlist', (req, res) => {
    const data = loadYaml(agencyYamlPath());
    res.json(data);
  });

  router.put('/agency/allowlist', (req, res) => {
    const { actions, global: globalCfg, integrations } = req.body || {};
    const current = loadYaml(agencyYamlPath());
    if (actions && typeof actions === 'object') {
      current.actions = current.actions || {};
      for (const [name, updates] of Object.entries(actions)) {
        if (!current.actions[name]) continue;
        if (typeof updates.enabled === 'boolean') current.actions[name].enabled = updates.enabled;
        if (typeof updates.dry_run === 'boolean') current.actions[name].dry_run = updates.dry_run;
        if (typeof updates.max_per_hour === 'number' && updates.max_per_hour >= 0) {
          current.actions[name].max_per_hour = updates.max_per_hour;
        }
      }
    }
    if (globalCfg && typeof globalCfg === 'object') {
      current.global = current.global || {};
      if (typeof globalCfg.enabled === 'boolean') current.global.enabled = globalCfg.enabled;
      if (typeof globalCfg.max_per_hour === 'number') current.global.max_per_hour = globalCfg.max_per_hour;
    }
    if (integrations && typeof integrations === 'object') {
      current.integrations = current.integrations || {};
      for (const [name, cfg] of Object.entries(integrations)) {
        current.integrations[name] = { ...(current.integrations[name] || {}), ...cfg };
      }
    }
    saveYaml(agencyYamlPath(), current);
    res.json({ ok: true });
  });

  router.get('/agency/recent', (req, res) => {
    const targetAgent = resolveRequestedAgent(req.query.agent);
    if (!targetAgent) return res.json({ agent: null, actions: [] });
    const logPath = path.join(home23Root, 'instances', targetAgent, 'brain', 'actions.jsonl');
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    const actions = [];
    if (fs.existsSync(logPath)) {
      try {
        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
        for (const line of lines) {
          try { actions.push(JSON.parse(line)); } catch { /* skip bad line */ }
        }
      } catch { /* file race, return what we have */ }
    }
    res.json({ agent: targetAgent, actions: actions.reverse() });
  });

  router.get('/agency/requested', (req, res) => {
    const targetAgent = resolveRequestedAgent(req.query.agent);
    if (!targetAgent) return res.json({ agent: null, requests: [] });
    const p = path.join(home23Root, 'instances', targetAgent, 'brain', 'requested-actions.jsonl');
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    const requests = [];
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
      for (const line of lines) {
        try { requests.push(JSON.parse(line)); } catch { /* skip */ }
      }
    }
    res.json({ agent: targetAgent, requests: requests.reverse() });
  });

  router.get('/system', (req, res) => {
    const homeConfig = loadHomeConfig();
    res.json({
      evobrew: homeConfig.evobrew || {},
      cosmo23: homeConfig.cosmo23 || {},
      embeddings: homeConfig.embeddings || {},
      chat: {
        maxTokens: homeConfig.chat?.maxTokens,
        temperature: homeConfig.chat?.temperature,
        historyBudget: homeConfig.chat?.historyBudget,
        sessionGapMs: homeConfig.chat?.sessionGapMs,
      },
    });
  });

  router.put('/system', (req, res) => {
    const configPath = getHomeConfigPath();
    const homeConfig = loadYaml(configPath);
    const { evobrew, cosmo23, embeddings, chat } = req.body;

    if (evobrew?.port !== undefined) {
      if (!homeConfig.evobrew) homeConfig.evobrew = {};
      homeConfig.evobrew.port = evobrew.port;
    }
    if (cosmo23?.ports) {
      if (!homeConfig.cosmo23) homeConfig.cosmo23 = {};
      if (!homeConfig.cosmo23.ports) homeConfig.cosmo23.ports = {};
      Object.assign(homeConfig.cosmo23.ports, cosmo23.ports);
    }
    if (embeddings?.providers) {
      homeConfig.embeddings = { providers: embeddings.providers };
    }
    if (chat) {
      if (!homeConfig.chat) homeConfig.chat = {};
      if (chat.maxTokens !== undefined) homeConfig.chat.maxTokens = chat.maxTokens;
      if (chat.temperature !== undefined) homeConfig.chat.temperature = chat.temperature;
      if (chat.historyBudget !== undefined) homeConfig.chat.historyBudget = chat.historyBudget;
      if (chat.sessionGapMs !== undefined) homeConfig.chat.sessionGapMs = chat.sessionGapMs;
    }

    saveYaml(configPath, homeConfig);
    regenerateEcosystem();
    regenerateEvobrewConfig();
    res.json({ ok: true });
  });

  // ── Skills (host-wide settings + credentials) ──

  router.get('/skills', async (_req, res) => {
    try {
      const [skillLoader, homeConfig, secrets] = await Promise.all([
        importSkillLoader(),
        Promise.resolve(loadHomeConfig()),
        Promise.resolve(loadSecrets()),
      ]);

      const skills = skillLoader.listSkills();
      const audit = skillLoader.auditSkills({ telemetryDays: 30 });
      const auditsById = new Map((audit.skills || []).map((entry) => [entry.id, entry]));

      const xResearchConfig = normalizeXResearchSettings(homeConfig.skills?.['x-research'] || {});
      const xResearchSecret = secrets.skills?.['x-research'] || {};
      const watchlistPath = path.join(home23Root, 'workspace', 'skills', 'x-research', 'data', 'watchlist.json');
      let watchlistCount = 0;
      if (fs.existsSync(watchlistPath)) {
        try {
          const watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
          watchlistCount = Array.isArray(watchlist.accounts) ? watchlist.accounts.length : 0;
        } catch {
          watchlistCount = 0;
        }
      }

      res.json({
        configPath: getHomeConfigPath(),
        secretsPath: getSecretsPath(),
        skills: skills.map((skill) => {
          const auditEntry = auditsById.get(skill.id) || null;
          const isXResearch = skill.id === 'x-research';
          return {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            category: skill.category,
            runtime: skill.runtime,
            type: skill.type,
            operational: skill.hasEntry === true,
            actions: skill.actions || [],
            hooks: skill.hookNames || [],
            audit: auditEntry ? {
              status: auditEntry.status,
              score: auditEntry.score,
              undertriggerRisk: auditEntry.undertriggerRisk,
              runCount: auditEntry.usage?.runCount || 0,
              failureCount: auditEntry.usage?.failureCount || 0,
              lastUsedAt: auditEntry.usage?.lastUsedAt || null,
            } : null,
            settings: isXResearch ? {
              authRequired: true,
              configured: !!xResearchSecret.bearerToken,
              maskedBearerToken: maskKey(xResearchSecret.bearerToken || ''),
              watchlistCount,
              defaults: xResearchConfig.defaults,
            } : {
              authRequired: false,
            },
          };
        }),
        xResearch: {
          defaults: xResearchConfig.defaults,
          configured: !!xResearchSecret.bearerToken,
          maskedBearerToken: maskKey(xResearchSecret.bearerToken || ''),
          watchlistCount,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.put('/skills', async (req, res) => {
    const updates = req.body?.skills;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ ok: false, error: 'skills object required' });
    }

    const homeConfigPath = getHomeConfigPath();
    const homeConfig = loadHomeConfig();

    if (!homeConfig.skills || typeof homeConfig.skills !== 'object') homeConfig.skills = {};

    const applied = [];
    let xResearchSecretUpdate = null;

    if (updates['x-research'] && typeof updates['x-research'] === 'object') {
      const incoming = updates['x-research'];
      const current = normalizeXResearchSettings(homeConfig.skills['x-research'] || {});
      homeConfig.skills['x-research'] = {
        ...(homeConfig.skills['x-research'] || {}),
        defaults: {
          quick: incoming.defaults?.quick !== undefined ? !!incoming.defaults.quick : current.defaults.quick,
          saveMarkdown: incoming.defaults?.saveMarkdown !== undefined ? !!incoming.defaults.saveMarkdown : current.defaults.saveMarkdown,
        },
      };
      applied.push('skills.x-research.defaults');

      if (typeof incoming.bearerToken === 'string' && incoming.bearerToken.trim()) {
        xResearchSecretUpdate = { bearerToken: incoming.bearerToken.trim(), clear: false };
        applied.push('skills.x-research.bearerToken');
      } else if (incoming.clearBearerToken === true) {
        xResearchSecretUpdate = { bearerToken: '', clear: true };
        applied.push('skills.x-research.bearerToken:cleared');
      }
    }

    saveYaml(homeConfigPath, homeConfig);
    if (xResearchSecretUpdate) {
      try {
        await updateSettingsSecrets(home23Root, (secrets) => {
          if (!secrets.skills || typeof secrets.skills !== 'object') secrets.skills = {};
          if (!secrets.skills['x-research'] || typeof secrets.skills['x-research'] !== 'object') {
            secrets.skills['x-research'] = {};
          }
          const skillSecrets = secrets.skills['x-research'];
          if (xResearchSecretUpdate.clear) {
            if (!Object.hasOwn(skillSecrets, 'bearerToken')) return { changed: false };
            delete skillSecrets.bearerToken;
            return { changed: true };
          }
          if (skillSecrets.bearerToken === xResearchSecretUpdate.bearerToken) return { changed: false };
          skillSecrets.bearerToken = xResearchSecretUpdate.bearerToken;
          return { changed: true };
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    res.json({
      ok: true,
      applied,
      requiresRestart: [],
    });
  });

  router.post('/system/install', (req, res) => {
    const { execSync } = require('child_process');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const dirs = [
      { name: 'engine', path: path.join(home23Root, 'engine') },
      { name: 'feeder', path: path.join(home23Root, 'feeder') },
      { name: 'harness', path: home23Root },
      { name: 'evobrew', path: path.join(home23Root, 'evobrew') },
      { name: 'cosmo23', path: path.join(home23Root, 'cosmo23') },
    ];

    for (const dir of dirs) {
      if (fs.existsSync(path.join(dir.path, 'package.json'))) {
        res.write(`data: {"step":"${dir.name}","status":"installing"}\n\n`);
        try {
          execSync('npm install', { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
          res.write(`data: {"step":"${dir.name}","status":"done"}\n\n`);
        } catch (err) {
          res.write(`data: {"step":"${dir.name}","status":"failed","error":"${(err.message || '').split('\\n')[0]}"}\n\n`);
        }
      }
    }
    res.write(`data: {"step":"complete","status":"done"}\n\n`);
    res.end();
  });

  router.post('/system/build', (req, res) => {
    const { execSync } = require('child_process');
    try {
      execSync('npx tsc', { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.stderr?.toString()?.slice(0, 500) || err.message });
    }
  });

  // ── OAuth broker (STEP 18) ──
  // Anthropic + OpenAI Codex OAuth flows are handled by the bundled cosmo23
  // server (which has the full PKCE + Prisma + encryption stack). Home23
  // proxies to cosmo23's /api/oauth/* routes and mirrors the resulting tokens
  // into config/secrets.yaml so they flow to the harness + engine via
  // ecosystem.config.cjs and PM2 env injection.

  const COSMO23_BASE = `http://localhost:${process.env.COSMO23_PORT || '43210'}`;

  async function cosmoFetch(path, init) {
    const url = `${COSMO23_BASE}${path}`;
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await res.json() : { success: false, error: await res.text() };
    return { status: res.status, body };
  }

  async function syncOAuthTokenToSecrets(provider) {
    // provider: 'anthropic' | 'openai-codex'
    const { body, status } = await cosmoFetch(`/api/oauth/${provider}/raw-token`);
    if (status !== 200 || !body?.ok || !body?.token) {
      return { ok: false, error: body?.error || `cosmo23 returned ${status}` };
    }
    const tokenUpdate = await updateDashboardOAuthTokenSecrets(home23Root, provider, body.token);

    // Regenerate ecosystem so new env vars land in PM2
    regenerateEcosystem();

    const targets = discoverAgents().flatMap(name => [`home23-${name}`, `home23-${name}-harness`]);
    try {
      const restartedTargets = restartOnlineEcosystemProcesses(targets);
      return {
        ok: true,
        restarted: restartedTargets.length > 0,
        rotated: tokenUpdate.value.rotated,
        targets: restartedTargets,
      };
    } catch (err) {
      return { ok: true, restarted: false, rotated: tokenUpdate.value.rotated, warn: `token written, restart failed: ${err.message}` };
    }
  }

  async function clearOAuthTokenFromSecrets(provider) {
    const cleared = await updateSettingsSecrets(home23Root, (secrets) => {
      if (!secrets.providers?.[provider]?.oauthManaged) return { changed: false };
      delete secrets.providers[provider].apiKey;
      delete secrets.providers[provider].oauthManaged;
      return { changed: true };
    });
    if (cleared.changed) {
      regenerateEcosystem();
      try {
        restartOnlineEcosystemProcesses(discoverAgents().flatMap(name => [`home23-${name}`, `home23-${name}-harness`]));
      } catch { /* best-effort */ }
    }
  }

  // Aggregated status for both providers in one call
  router.get('/oauth/status', async (_req, res) => {
    const [anthropic, codex] = await Promise.all([
      cosmoFetch('/api/oauth/anthropic/status').catch(() => ({ body: null })),
      cosmoFetch('/api/oauth/openai-codex/status').catch(() => ({ body: null })),
    ]);
    const a = anthropic.body?.oauth || { configured: false };
    const c = codex.body?.oauth || { configured: false };
    res.json({
      anthropic: {
        configured: !!a.configured,
        valid: !!a.valid,
        source: a.source || 'none',
        expiresAt: a.expiresAt || null,
      },
      openaiCodex: {
        configured: !!c.configured,
        valid: !!c.valid,
        source: c.source || 'none',
        expiresAt: c.expiresAt || null,
      },
    });
  });

  // Anthropic routes
  router.post('/oauth/anthropic/import-cli', async (_req, res) => {
    try {
      const { status, body } = await cosmoFetch('/api/oauth/anthropic/import-cli', { method: 'POST' });
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'import failed' });
      const sync = await syncOAuthTokenToSecrets('anthropic');
      res.json({ ok: true, expiresAt: body.expiresAt, ...sync });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/oauth/anthropic/start', async (_req, res) => {
    try {
      const { status, body } = await cosmoFetch('/api/oauth/anthropic/start', { method: 'POST' });
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'start failed' });
      res.json({ ok: true, authUrl: body.authUrl, expiresInSeconds: body.expiresInSeconds });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/oauth/anthropic/callback', async (req, res) => {
    try {
      const callbackUrl = req.body?.callbackUrl;
      if (!callbackUrl) return res.status(400).json({ ok: false, error: 'callbackUrl required' });
      // cosmo23 /api/oauth/anthropic/callback accepts either ?callbackUrl=... or ?code=&state=
      const { status, body } = await cosmoFetch(
        `/api/oauth/anthropic/callback?callbackUrl=${encodeURIComponent(callbackUrl)}`
      );
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'callback failed' });
      const sync = await syncOAuthTokenToSecrets('anthropic');
      res.json({ ok: true, expiresAt: body.expiresAt, ...sync });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/oauth/anthropic/logout', async (_req, res) => {
    try {
      const { status, body } = await cosmoFetch('/api/oauth/anthropic/logout', { method: 'POST' });
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'logout failed' });
      await clearOAuthTokenFromSecrets('anthropic');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // OpenAI Codex routes
  router.post('/oauth/openai-codex/import-evobrew', async (_req, res) => {
    try {
      const { status, body } = await cosmoFetch('/api/oauth/openai-codex/import', { method: 'POST' });
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'import failed' });
      const sync = await syncOAuthTokenToSecrets('openai-codex');
      res.json({ ok: true, accountId: body.accountId, expiresAt: body.expiresAt, ...sync });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Note: Codex OAuth /start on cosmo23 blocks until its local callback server
  // receives the code (it runs its own loopback server on port 1455 and opens
  // the browser server-side). That's fine for localhost use — the UI just
  // shows a "completing OAuth..." spinner while this call is outstanding.
  router.post('/oauth/openai-codex/start', async (_req, res) => {
    try {
      const { status, body } = await cosmoFetch('/api/oauth/openai-codex/start', { method: 'POST' });
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'start failed' });
      const sync = await syncOAuthTokenToSecrets('openai-codex');
      res.json({ ok: true, accountId: body.accountId, expiresAt: body.expiresAt, ...sync });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/oauth/openai-codex/logout', async (_req, res) => {
    try {
      const { status, body } = await cosmoFetch('/api/oauth/openai-codex/logout', { method: 'POST' });
      if (!body?.success) return res.status(status || 500).json({ ok: false, error: body?.error || 'logout failed' });
      await clearOAuthTokenFromSecrets('openai-codex');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Feeder configuration (STEP 17) ──
  // Base defaults live in configs/base-engine.yaml under the `feeder:` block,
  // while per-agent overrides live in instances/<agent>/config.yaml:feeder.
  // Some fields hot-apply via the engine's /admin/feeder/* routes; others
  // require that specific agent's engine to restart.

  const BASE_ENGINE_PATH = path.join(home23Root, 'configs', 'base-engine.yaml');

  const FEEDER_DEFAULTS = {
    enabled: true,
    additionalWatchPaths: [],
    excludePatterns: [],
    chunking: { maxChunkSize: 3000, overlap: 300 },
    flush: { batchSize: 20, intervalSeconds: 30 },
    compiler: { enabled: true, model: 'MiniMax-M3' },
    converter: { enabled: true, visionModel: 'gpt-4o-mini', pythonPath: 'python3' },
  };

  function mergeFeederConfig(baseStored, overrideStored = null) {
    const s = baseStored || {};
    const o = overrideStored && typeof overrideStored === 'object' ? overrideStored : {};
    return {
      enabled: o.enabled !== undefined ? o.enabled !== false : s.enabled !== false,
      additionalWatchPaths: Array.isArray(o.additionalWatchPaths)
        ? o.additionalWatchPaths
        : (Array.isArray(s.additionalWatchPaths) ? s.additionalWatchPaths : []),
      excludePatterns: Array.isArray(o.excludePatterns)
        ? o.excludePatterns
        : (Array.isArray(s.excludePatterns) ? s.excludePatterns : []),
      chunking: {
        maxChunkSize: o.chunking?.maxChunkSize ?? s.chunking?.maxChunkSize ?? FEEDER_DEFAULTS.chunking.maxChunkSize,
        overlap: o.chunking?.overlap ?? s.chunking?.overlap ?? FEEDER_DEFAULTS.chunking.overlap,
      },
      flush: {
        batchSize: o.flush?.batchSize ?? s.flush?.batchSize ?? FEEDER_DEFAULTS.flush.batchSize,
        intervalSeconds: o.flush?.intervalSeconds ?? s.flush?.intervalSeconds ?? FEEDER_DEFAULTS.flush.intervalSeconds,
      },
      compiler: {
        enabled: o.compiler?.enabled !== undefined ? o.compiler.enabled !== false : s.compiler?.enabled !== false,
        model: o.compiler?.model || s.compiler?.model || FEEDER_DEFAULTS.compiler.model,
      },
      converter: {
        enabled: o.converter?.enabled !== undefined ? o.converter.enabled !== false : s.converter?.enabled !== false,
        visionModel: o.converter?.visionModel || s.converter?.visionModel || FEEDER_DEFAULTS.converter.visionModel,
        pythonPath: o.converter?.pythonPath || s.converter?.pythonPath || FEEDER_DEFAULTS.converter.pythonPath,
      },
    };
  }

  router.get('/feeder', (req, res) => {
    const targetAgent = resolveRequestedAgent(req.query.agent);
    if (!targetAgent) {
      return res.status(400).json({ ok: false, error: 'No target agent selected' });
    }
    const baseEngine = loadYaml(BASE_ENGINE_PATH);
    const agentConfigPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
    const agentConfig = loadYaml(agentConfigPath);
    const feeder = mergeFeederConfig(baseEngine.feeder || {}, agentConfig.feeder || {});
    // Also surface the auto-added watch paths that the orchestrator wires on startup
    const autoWatchPaths = [];
    const targetRuntimeDir = path.join(home23Root, 'instances', targetAgent, 'brain');
    const targetWorkspacePath = path.join(home23Root, 'instances', targetAgent, 'workspace');
    if (targetRuntimeDir) {
      autoWatchPaths.push({
        path: path.join(targetRuntimeDir, 'ingestion', 'documents'),
        label: 'dropzone (auto)',
        source: 'orchestrator:ingestion-directory',
        readOnly: true,
      });
    }
    if (targetWorkspacePath) {
      autoWatchPaths.push({
        path: targetWorkspacePath,
        label: 'workspace (auto)',
        source: 'orchestrator:COSMO_WORKSPACE_PATH',
        readOnly: true,
      });
    }
    res.json({
      agent: targetAgent,
      feeder,
      autoWatchPaths,
      configPath: agentConfigPath,
      inheritedFrom: BASE_ENGINE_PATH,
    });
  });

  router.put('/feeder', (req, res) => {
    const { feeder: input } = req.body || {};
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ ok: false, error: 'feeder object required' });
    }

    const targetAgent = resolveRequestedAgent(req.query.agent || req.body?.agent);
    if (!targetAgent) {
      return res.status(400).json({ ok: false, error: 'No target agent selected' });
    }

    const baseEngine = loadYaml(BASE_ENGINE_PATH);
    const agentConfigPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
    const agentConfig = loadYaml(agentConfigPath);
    const current = mergeFeederConfig(baseEngine.feeder || {}, agentConfig.feeder || {});
    const incoming = mergeFeederConfig(baseEngine.feeder || {}, input);

    // Classify changes as hot-apply vs restart-required
    const applied = [];
    const requiresRestart = [];

    // Hot-apply candidates: compiler.enabled, compiler.model, additionalWatchPaths additions
    if (current.compiler.enabled !== incoming.compiler.enabled || current.compiler.model !== incoming.compiler.model) {
      applied.push('compiler');
    }
    const currentPaths = new Set((current.additionalWatchPaths || []).map((p) => JSON.stringify({ path: p.path || p, label: p.label || null })));
    const incomingPaths = new Set((incoming.additionalWatchPaths || []).map((p) => JSON.stringify({ path: p.path || p, label: p.label || null })));
    for (const p of incomingPaths) if (!currentPaths.has(p)) applied.push(`watchPath:+${JSON.parse(p).path}`);
    for (const p of currentPaths) if (!incomingPaths.has(p)) requiresRestart.push(`watchPath:-${JSON.parse(p).path}`);

    // Restart-required: flush, chunking, converter, excludePatterns
    if (current.flush.batchSize !== incoming.flush.batchSize) requiresRestart.push('flush.batchSize');
    if (current.flush.intervalSeconds !== incoming.flush.intervalSeconds) requiresRestart.push('flush.intervalSeconds');
    if (current.chunking.maxChunkSize !== incoming.chunking.maxChunkSize) requiresRestart.push('chunking.maxChunkSize');
    if (current.chunking.overlap !== incoming.chunking.overlap) requiresRestart.push('chunking.overlap');
    if (current.converter.enabled !== incoming.converter.enabled) requiresRestart.push('converter.enabled');
    if (current.converter.visionModel !== incoming.converter.visionModel) requiresRestart.push('converter.visionModel');
    if (current.converter.pythonPath !== incoming.converter.pythonPath) requiresRestart.push('converter.pythonPath');
    if (JSON.stringify(current.excludePatterns) !== JSON.stringify(incoming.excludePatterns)) requiresRestart.push('excludePatterns');

    // Persist to the selected agent's config.yaml. Shared base-engine.yaml stays
    // as the default fallback for agents without explicit overrides.
    agentConfig.feeder = {
      enabled: incoming.enabled,
      additionalWatchPaths: incoming.additionalWatchPaths,
      excludePatterns: incoming.excludePatterns,
      chunking: incoming.chunking,
      flush: incoming.flush,
      compiler: incoming.compiler,
      converter: incoming.converter,
    };
    saveYaml(agentConfigPath, agentConfig);

    res.json({ ok: true, agent: targetAgent, applied, requiresRestart });
  });

  // ─── Vibe (dashboard) ───────────────────────────────────────────────────────
  // Lives in config/home.yaml under dashboard.vibe. Hot-apply only — the vibe
  // service re-reads config on each generation call, so no restart needed.

  const VIBE_DEFAULTS = {
    autoGenerate: true,
    generationIntervalHours: 12,
    rotationIntervalSeconds: 45,
    galleryLimit: 60,
    sourcePaths: [],
    dreams: {
      enabled: true,
      lookback: 3,
      extraction: 'heuristic',
    },
  };

  function normalizeSourcePathsInput(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }

  function mergeVibeConfig(s = {}) {
    const dreams = (s.dreams && typeof s.dreams === 'object') ? s.dreams : {};
    return {
      autoGenerate: s.autoGenerate !== false,
      generationIntervalHours: Number(s.generationIntervalHours) || VIBE_DEFAULTS.generationIntervalHours,
      rotationIntervalSeconds: Number(s.rotationIntervalSeconds) || VIBE_DEFAULTS.rotationIntervalSeconds,
      galleryLimit: Number(s.galleryLimit) || VIBE_DEFAULTS.galleryLimit,
      sourcePaths: normalizeSourcePathsInput(s.sourcePaths),
      dreams: {
        enabled: dreams.enabled !== false,
        lookback: Number(dreams.lookback) || VIBE_DEFAULTS.dreams.lookback,
        extraction: String(dreams.extraction || 'heuristic').toLowerCase() === 'llm' ? 'llm' : 'heuristic',
      },
    };
  }

  router.get('/vibe', (_req, res) => {
    const homeConfig = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    const vibe = mergeVibeConfig(homeConfig.dashboard?.vibe || {});
    res.json({
      vibe,
      imageGeneration: normalizeImageGenerationSettings(homeConfig.media?.imageGeneration || {}),
      imageProviders: IMAGE_PROVIDER_CATALOG,
    });
  });

  router.put('/vibe', (req, res) => {
    const { vibe: input, imageGeneration } = req.body || {};
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ ok: false, error: 'vibe object required' });
    }
    const configPath = path.join(home23Root, 'config', 'home.yaml');
    const homeConfig = loadYaml(configPath);
    if (!homeConfig.dashboard) homeConfig.dashboard = {};
    homeConfig.dashboard.vibe = mergeVibeConfig(input);
    if (imageGeneration && typeof imageGeneration === 'object') {
      if (!homeConfig.media) homeConfig.media = {};
      homeConfig.media.imageGeneration = normalizeImageGenerationSettings(imageGeneration);
    }
    saveYaml(configPath, homeConfig);
    res.json({
      ok: true,
      vibe: homeConfig.dashboard.vibe,
      imageGeneration: normalizeImageGenerationSettings(homeConfig.media?.imageGeneration || {}),
      applied: ['vibe', 'imageGeneration'],
      requiresRestart: [],
    });
  });

  // ─── Tiles (STEP 22) ──────────────────────────────────────────────────────

  router.get('/tiles', (_req, res) => {
    try {
      res.json({ tiles: tileService.getSettingsTilesPayload() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.put('/tiles', (req, res) => {
    try {
      const { tiles: input } = req.body || {};
      if (!input || typeof input !== 'object') {
        return res.status(400).json({ ok: false, error: 'tiles object required' });
      }

      const tiles = tileService.saveTilesSettings(input);
      res.json({
        ok: true,
        tiles,
        applied: ['dashboard.tiles'],
        requiresRestart: [],
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/tile-connections', (_req, res) => {
    try {
      res.json({ connections: tileService.getSettingsConnectionsPayload() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.put('/tile-connections', async (req, res) => {
    try {
      const { connections: input } = req.body || {};
      if (!input || !Array.isArray(input.connections)) {
        return res.status(400).json({ ok: false, error: 'connections.connections array required' });
      }

      const saved = await tileService.saveConnectionsSettings(input);
      res.json({
        ok: true,
        connections: tileService.getSettingsConnectionsPayload().connections,
        applied: ['dashboard.tileConnections'],
        requiresRestart: [],
        savedCount: saved.connections.length,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return { router, loadYaml, saveYaml, discoverAgents };
}

module.exports = {
  applyModelAuthorityRuntimeRefresh,
  assertNoSharedPm2Targets,
  createSettingsRouter,
  planModelAuthorityRuntimeTargets,
  updateSettingsSecrets,
};
