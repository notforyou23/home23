const express = require('express');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const { Home23TileService } = require('./home23-tiles');

function createSettingsRouter(home23Root) {
  const router = express.Router();
  const tileService = new Home23TileService({ home23Root });

  function loadYaml(filePath) {
    if (!fs.existsSync(filePath)) return {};
    return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  }

  function saveYaml(filePath, data) {
    fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: 120 }), 'utf8');
  }

  function seedCosmo23Config() {
    try {
      const { execSync } = require('child_process');
      execSync(`node --input-type=module -e "
        import { seedCosmo23Config } from './cli/lib/cosmo23-config.js';
        seedCosmo23Config('.');
      "`, { cwd: home23Root, stdio: 'pipe', timeout: 10000 });
    } catch (err) {
      console.warn('[Settings] cosmo23 config seed error:', err.message);
    }
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
    const { execSync } = require('child_process');
    const jlist = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', stdio: 'pipe' }));
    return new Set(
      jlist
        .filter(proc => proc.pm2_env?.status === 'online')
        .map(proc => proc.name)
    );
  }

  function restartOnlineEcosystemProcesses(targets) {
    const { execSync } = require('child_process');
    const ecosystemPath = path.join(home23Root, 'ecosystem.config.cjs');
    const online = listOnlinePm2ProcessNames();
    const activeTargets = targets.filter(name => online.has(name));

    for (const name of activeTargets) {
      try { execSync(`pm2 delete ${name}`, { stdio: 'pipe', timeout: 15000 }); } catch { /* best-effort */ }
    }
    if (activeTargets.length > 0) {
      execSync(`pm2 start ${ecosystemPath} --only ${activeTargets.join(',')}`, {
        cwd: home23Root,
        stdio: 'pipe',
        timeout: 45000,
      });
    }
    return activeTargets;
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
        { method: 'POST', path: '/agents/:name/restart-harness' },
        { method: 'POST', path: '/agents/:name/stop' },
      ],
    },
    models: {
      kind: 'mixed',
      chip: 'Mixed',
      agentTarget: 'selected',
      summaryTemplate: 'Models is mixed-scope. {{selectedAgent}} gets the runtime defaults above, while provider catalogs, aliases, and image generation stay house-wide.',
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
      kind: 'global',
      chip: 'Global',
      agentTarget: 'none',
      summaryTemplate: 'Document Feeder is house-wide. Watch paths, compiler settings, and uploads affect the shared Home23 ingestion pipeline.',
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
      models: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'],
    },
    minimax: {
      displayName: 'MiniMax',
      models: ['image-01'],
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

  router.put('/providers', (req, res) => {
    const { providers } = req.body;
    if (!providers || typeof providers !== 'object') {
      return res.status(400).json({ error: 'providers object required' });
    }

    const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
    const secrets = loadSecrets();
    if (!secrets.providers) secrets.providers = {};

    for (const [name, config] of Object.entries(providers)) {
      if (config.apiKey && config.apiKey.trim()) {
        if (!secrets.providers[name]) secrets.providers[name] = {};
        secrets.providers[name].apiKey = config.apiKey.trim();
      }
    }

    saveYaml(secretsPath, secrets);
    regenerateEcosystem();
    regenerateEvobrewConfig();
    seedCosmo23Config();

    try {
      const targets = [
        ...discoverAgents().flatMap(name => [`home23-${name}`, `home23-${name}-harness`]),
        'home23-evobrew',
        'home23-cosmo23',
      ];
      const restartedTargets = restartOnlineEcosystemProcesses(targets);
      res.json({ ok: true, restarted: restartedTargets.length > 0, targets: restartedTargets });
    } catch (err) {
      res.json({ ok: true, restarted: false, warn: err.message });
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
          model: 'MiniMax-M2.7',
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

  function regenerateEcosystem() {
    try {
      const { execSync } = require('child_process');
      execSync(`node --input-type=module -e "
        import { generateEcosystem } from './cli/lib/generate-ecosystem.js';
        generateEcosystem('.');
      "`, { cwd: home23Root, stdio: 'pipe', timeout: 10000 });
    } catch (err) {
      console.warn('[Settings] Ecosystem regeneration error:', err.message);
    }
  }

  function regenerateEvobrewConfig() {
    try {
      const { execSync } = require('child_process');
      execSync(`node --input-type=module -e "
        import { writeEvobrewConfig } from './cli/lib/evobrew-config.js';
        writeEvobrewConfig('.');
      "`, { cwd: home23Root, stdio: 'pipe', timeout: 10000 });
    } catch (err) {
      console.warn('[Settings] Evobrew config regeneration error:', err.message);
    }
  }

  router.post('/agents', (req, res) => {
    const { name, displayName, ownerName, ownerTelegramId, timezone, botToken, model, provider } = req.body;

    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase alphanumeric with hyphens' });
    }

    const instanceDir = path.join(home23Root, 'instances', name);
    if (fs.existsSync(instanceDir)) {
      return res.status(409).json({ error: `Agent "${name}" already exists` });
    }

    // Determine if this is the first agent (will be primary)
    const isFirst = discoverAgents().length === 0;

    const ports = findNextPorts();

    for (const dir of ['workspace', 'brain', 'conversations', 'conversations/sessions', 'logs', 'cron-runs']) {
      fs.mkdirSync(path.join(instanceDir, dir), { recursive: true });
    }

    const agentConfig = {
      agent: {
        name,
        displayName: displayName || name.charAt(0).toUpperCase() + name.slice(1),
        owner: { name: ownerName || 'owner', telegramId: ownerTelegramId || undefined },
        timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
        maxSubAgents: 3,
      },
      ports,
      engine: { thought: model || 'minimax-m2.7', consolidation: model || 'minimax-m2.7', dreaming: model || 'minimax-m2.7', query: model || 'minimax-m2.7' },
      channels: {
        telegram: botToken
          ? { enabled: true, streaming: 'partial', dmPolicy: 'open', groupPolicy: 'restricted', groups: {}, ackReaction: true }
          : { enabled: false },
      },
      system: { name: 'home23', version: '0.1.0', workspace: 'workspace' },
      chat: {
        provider: provider || 'ollama-cloud',
        model: model || 'kimi-k2.5',
        defaultProvider: provider || 'ollama-cloud',
        defaultModel: model || 'kimi-k2.5',
        maxTokens: 4096, temperature: 0.7, historyDepth: 20, historyBudget: 400000, sessionGapMs: 1800000,
        memorySearch: { enabled: false, timeoutMs: 10000, topK: 5 },
        identityFiles: ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'LEARNINGS.md', 'COSMO_RESEARCH.md'],
        heartbeatRefreshMs: 60000,
      },
      sessions: {
        threadBindings: { enabled: true, idleHours: 24 },
        messageQueue: { mode: 'collect', debounceMs: 3000, adaptiveDebounce: true, cap: 10, overflowStrategy: 'summarize', queueDuringRun: true },
      },
      scheduler: { timezone: timezone || 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' },
      sibling: { enabled: false, name: '', remoteUrl: '', token: '', rateLimits: { maxPerMinute: 5, retries: 2, dedupWindowSeconds: 300 }, ackMode: false, bridgeChat: { enabled: false, dbPath: '', telegramBotToken: '', telegramTargetId: '' } },
      acp: { enabled: false, defaultAgent: '', allowedAgents: [], permissionMode: 'ask' },
      browser: { enabled: true, headless: true, cdpUrl: 'http://localhost:9222' },
      tts: { enabled: false, auto: 'off', provider: '', apiKey: '', voiceId: '', modelId: '' },
    };

    saveYaml(path.join(instanceDir, 'config.yaml'), agentConfig);

    const feederConfig = {
      member: name,
      state_file: `../instances/${name}/brain/state.json.gz`,
      watch: [{ path: `../instances/${name}/workspace`, label: 'workspace', glob: '*.md' }],
      ollama: { endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text', dims: 768 },
      flush_interval_seconds: 300, flush_batch_size: 20,
    };
    saveYaml(path.join(instanceDir, 'feeder.yaml'), feederConfig);

    const dName = displayName || name.charAt(0).toUpperCase() + name.slice(1);
    const templateVars = { displayName: dName, name, ownerName: ownerName || 'owner' };
    for (const file of ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'LEARNINGS.md', 'COSMO_RESEARCH.md']) {
      const template = loadTemplate(file);
      const content = renderTemplate(template, templateVars);
      fs.writeFileSync(path.join(instanceDir, 'workspace', file), content, 'utf8');
    }

    // Seed domain surfaces for Situational Awareness Engine (Step 20)
    const today = new Date().toISOString().split('T')[0];
    const surfaces = {
      'TOPOLOGY.md': `# House Topology\n\n_No services registered yet. The curator cycle will populate this as the agent learns about the house._\n\n_Last verified: ${today}. Source: initial setup._\n`,
      'PROJECTS.md': `# Active Projects\n\n_No projects tracked yet. Use promote_to_memory or conversation extraction to add projects._\n\n_Curator-maintained. Last updated: ${today}._\n`,
      'PERSONAL.md': `# Personal Context — ${ownerName || 'owner'}\n\n## Profile\n- Owner: ${ownerName || 'owner'}\n\n_Personal memory. Surface only on direct relevance. Curator-maintained._\n`,
      'DOCTRINE.md': `# Doctrine — How We Work\n\n## Conventions\n- Engine is JS. Harness is TS. Two languages, one system.\n- NEVER pm2 delete/stop all — scope commands to specific process names.\n\n_Curator-maintained. Includes boundaries and operating constraints._\n`,
      'RECENT.md': `# Recent Activity (Last 48 Hours)\n\n## ${today}\n\n### Agent created\n- ${dName} initialized with Home23\n- Situational awareness engine active\n\n_Auto-generated. Entries older than 48h drop from assembly loading._\n`,
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
      const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
      const secrets = loadYaml(secretsPath);
      if (!secrets.agents) secrets.agents = {};
      secrets.agents[name] = { telegram: { botToken } };
      saveYaml(secretsPath, secrets);
    }

    // Set as primary agent if first
    if (isFirst) {
      setPrimaryAgent(name);
    }

    regenerateEcosystem();

    res.json({ ok: true, agent: { name, displayName: dName, ports, isPrimary: isFirst } });
  });

  router.put('/agents/:name', (req, res) => {
    const agentName = req.params.name;
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Agent "${agentName}" not found` });
    }

    const config = loadYaml(configPath);
    const { displayName, ownerName, ownerTelegramId, timezone, model, provider } = req.body;

    if (displayName !== undefined) config.agent.displayName = displayName;
    if (ownerName !== undefined) config.agent.owner.name = ownerName;
    if (ownerTelegramId !== undefined) config.agent.owner.telegramId = ownerTelegramId;
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
      // Save bot token to secrets
      if (telegram.botToken) {
        const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
        const secrets = loadYaml(secretsPath);
        if (!secrets.agents) secrets.agents = {};
        if (!secrets.agents[agentName]) secrets.agents[agentName] = {};
        secrets.agents[agentName].telegram = { botToken: telegram.botToken };
        saveYaml(secretsPath, secrets);
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
      if (discord.token) {
        const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
        const secrets = loadYaml(secretsPath);
        if (!secrets.agents) secrets.agents = {};
        if (!secrets.agents[agentName]) secrets.agents[agentName] = {};
        secrets.agents[agentName].discord = { token: discord.token };
        saveYaml(secretsPath, secrets);
      }
    }

    saveYaml(configPath, config);
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

  router.delete('/agents/:name', (req, res) => {
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
      const names = [`home23-${agentName}`, `home23-${agentName}-dash`, `home23-${agentName}-feeder`, `home23-${agentName}-harness`];
      for (const n of names) {
        try { execSync(`pm2 stop ${n}`, { stdio: 'pipe' }); } catch { /* not running */ }
        try { execSync(`pm2 delete ${n}`, { stdio: 'pipe' }); } catch { /* not in list */ }
      }
    } catch { /* pm2 not available */ }

    fs.rmSync(instanceDir, { recursive: true, force: true });

    const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
    const secrets = loadYaml(secretsPath);
    if (secrets.agents?.[agentName]) {
      delete secrets.agents[agentName];
      saveYaml(secretsPath, secrets);
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
      const names = [`home23-${agentName}`, `home23-${agentName}-dash`, `home23-${agentName}-feeder`, `home23-${agentName}-harness`];
      execSync(`pm2 start ${ecosystemPath} --only ${names.join(',')}`, { cwd: home23Root, stdio: 'pipe', timeout: 30000 });
      res.json({ ok: true, status: 'running' });
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
      const names = [`home23-${agentName}`, `home23-${agentName}-dash`, `home23-${agentName}-feeder`, `home23-${agentName}-harness`];
      for (const n of names) {
        try { execSync(`pm2 stop ${n}`, { stdio: 'pipe' }); } catch { /* not running */ }
      }
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
      const { execSync } = require('child_process');
      const ecosystemPath = path.join(home23Root, 'ecosystem.config.cjs');
      // Seed config before starting
      try {
        const { seedCosmo23Config } = await import(path.join(home23Root, 'cli', 'lib', 'cosmo23-config.js'));
        seedCosmo23Config(home23Root);
      } catch { /* config seeding optional */ }
      execSync(`pm2 start ${ecosystemPath} --only home23-cosmo23`, { cwd: home23Root, stdio: 'pipe', timeout: 15000 });
      res.json({ ok: true, status: 'started' });
    } catch (err) {
      res.status(500).json({ error: err.message });
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

  router.put('/models', (req, res) => {
    const { agent, chat, aliases, providerModels, engineRoles, imageGeneration } = req.body || {};
    const configPath = getHomeConfigPath();
    const homeConfig = loadYaml(configPath);
    const targetAgent = resolveRequestedAgent(agent);
    const roleModels = engineRoles && typeof engineRoles === 'object' ? engineRoles : {};
    const chatChanged = !!chat;
    const engineRolesChanged = Object.keys(roleModels).length > 0;
    const defaultModel = chat?.defaultModel;
    let restartedHarness = false;
    let restartedAgent = false;
    let homeConfigDirty = false;

    if (chatChanged || engineRolesChanged) {
      if (!targetAgent) {
        return res.status(400).json({ error: 'No target agent selected' });
      }
      const agentConfigPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
      if (!fs.existsSync(agentConfigPath)) {
        return res.status(404).json({ error: `Agent "${targetAgent}" not found` });
      }
      const agentConfig = loadYaml(agentConfigPath);
      if (!agentConfig.chat) agentConfig.chat = {};
      if (chatChanged && chat?.defaultProvider !== undefined) {
        agentConfig.chat.provider = chat.defaultProvider;
        agentConfig.chat.defaultProvider = chat.defaultProvider;
      }
      if (chatChanged && chat?.defaultModel !== undefined) {
        agentConfig.chat.model = chat.defaultModel;
        agentConfig.chat.defaultModel = chat.defaultModel;
      }

      if (!agentConfig.engine) agentConfig.engine = {};
      for (const role of ['thought', 'consolidation', 'dreaming', 'query']) {
        agentConfig.engine[role] = roleModels[role] || defaultModel || agentConfig.engine[role];
      }
      saveYaml(agentConfigPath, agentConfig);

      if (chatChanged) {
        const effectiveProvider = agentConfig.chat.defaultProvider || agentConfig.chat.provider;
        const effectiveModel = agentConfig.chat.defaultModel || agentConfig.chat.model;
        syncAgentDefaultModelFiles(targetAgent, effectiveProvider, effectiveModel);
        try {
          restartedHarness = recycleManagedProcess(`home23-${targetAgent}-harness`);
        } catch (err) {
          console.error(`[Settings] Failed to restart ${targetAgent}-harness after chat model changes:`, err.message);
        }
      }

      if (chatChanged || engineRolesChanged) {
        try {
          restartedAgent = recycleManagedProcess(`home23-${targetAgent}`);
        } catch (err) {
          console.error(`[Settings] Failed to restart ${targetAgent} after model changes:`, err.message);
        }
      }
    }

    if (aliases !== undefined) {
      if (!homeConfig.models) homeConfig.models = {};
      homeConfig.models.aliases = aliases;
      homeConfigDirty = true;
    }
    if (providerModels) {
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

    if (homeConfigDirty) {
      saveYaml(configPath, homeConfig);
      regenerateEvobrewConfig();
    }

    res.json({ ok: true, agent: targetAgent, restartedAgent, restartedHarness });
  });

  // ── Query (Query-tab defaults) ──
  //
  // Stored under home.yaml:query. Read by the Query tab and by Settings.

  router.get('/query', (req, res) => {
    const homeConfig = loadHomeConfig();
    const targetAgent = resolveRequestedAgent(req.query.agent);
    const agentConfig = loadAgentConfig(targetAgent);
    const q = agentConfig.query || homeConfig.query || {};
    res.json({
      agent: targetAgent,
      defaultModel: q.defaultModel || '',
      defaultMode: q.defaultMode || 'full',
      enablePGSByDefault: !!q.enablePGSByDefault,
      pgsSweepModel: q.pgsSweepModel || '',
      pgsSynthModel: q.pgsSynthModel || '',
      pgsDepth: typeof q.pgsDepth === 'number' ? q.pgsDepth : 0.25,
    });
  });

  router.put('/query', (req, res) => {
    try {
      const targetAgent = resolveRequestedAgent(req.body?.agent);
      if (!targetAgent) {
        return res.status(400).json({ ok: false, error: 'No target agent selected' });
      }
      const configPath = path.join(home23Root, 'instances', targetAgent, 'config.yaml');
      const agentConfig = loadYaml(configPath);
      if (!agentConfig.query) agentConfig.query = {};
      const b = req.body || {};
      if (typeof b.defaultModel === 'string') agentConfig.query.defaultModel = b.defaultModel;
      if (typeof b.defaultMode === 'string') agentConfig.query.defaultMode = b.defaultMode;
      if (typeof b.enablePGSByDefault === 'boolean') agentConfig.query.enablePGSByDefault = b.enablePGSByDefault;
      if (typeof b.pgsSweepModel === 'string') agentConfig.query.pgsSweepModel = b.pgsSweepModel;
      if (typeof b.pgsSynthModel === 'string') agentConfig.query.pgsSynthModel = b.pgsSynthModel;
      if (typeof b.pgsDepth === 'number') agentConfig.query.pgsDepth = b.pgsDepth;
      saveYaml(configPath, agentConfig);
      res.json({ ok: true, agent: targetAgent });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
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

  function buildDefaultPulsePrompt({ agentLabel = 'the agent', ownerName = 'jtr' } = {}) {
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
    let ownerName = 'jtr';
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

  router.put('/skills', (req, res) => {
    const updates = req.body?.skills;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ ok: false, error: 'skills object required' });
    }

    const homeConfigPath = getHomeConfigPath();
    const secretsPath = getSecretsPath();
    const homeConfig = loadHomeConfig();
    const secrets = loadSecrets();

    if (!homeConfig.skills || typeof homeConfig.skills !== 'object') homeConfig.skills = {};
    if (!secrets.skills || typeof secrets.skills !== 'object') secrets.skills = {};

    const applied = [];

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

      if (!secrets.skills['x-research'] || typeof secrets.skills['x-research'] !== 'object') {
        secrets.skills['x-research'] = {};
      }

      if (typeof incoming.bearerToken === 'string' && incoming.bearerToken.trim()) {
        secrets.skills['x-research'].bearerToken = incoming.bearerToken.trim();
        applied.push('skills.x-research.bearerToken');
      } else if (incoming.clearBearerToken === true) {
        delete secrets.skills['x-research'].bearerToken;
        applied.push('skills.x-research.bearerToken:cleared');
      }
    }

    saveYaml(homeConfigPath, homeConfig);
    saveYaml(secretsPath, secrets);

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
    const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
    const secrets = loadYaml(secretsPath);
    if (!secrets.providers) secrets.providers = {};
    if (!secrets.providers[provider]) secrets.providers[provider] = {};
    const prev = secrets.providers[provider].apiKey || '';
    secrets.providers[provider].apiKey = body.token;
    secrets.providers[provider].oauthManaged = true;
    saveYaml(secretsPath, secrets);

    // Regenerate ecosystem so new env vars land in PM2
    regenerateEcosystem();

    const targets = discoverAgents().flatMap(name => [`home23-${name}`, `home23-${name}-harness`]);
    try {
      const restartedTargets = restartOnlineEcosystemProcesses(targets);
      return {
        ok: true,
        restarted: restartedTargets.length > 0,
        rotated: prev !== body.token,
        targets: restartedTargets,
      };
    } catch (err) {
      return { ok: true, restarted: false, rotated: prev !== body.token, warn: `token written, restart failed: ${err.message}` };
    }
  }

  async function clearOAuthTokenFromSecrets(provider) {
    const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
    const secrets = loadYaml(secretsPath);
    if (secrets.providers?.[provider]?.oauthManaged) {
      delete secrets.providers[provider].apiKey;
      delete secrets.providers[provider].oauthManaged;
      saveYaml(secretsPath, secrets);
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
  // The feeder config lives in configs/base-engine.yaml under the `feeder:` block.
  // It's shared across all home23 agents on this host. Some fields hot-apply via
  // the engine's /admin/feeder/* routes; others require an engine restart.

  const BASE_ENGINE_PATH = path.join(home23Root, 'configs', 'base-engine.yaml');

  const FEEDER_DEFAULTS = {
    enabled: true,
    additionalWatchPaths: [],
    excludePatterns: [],
    chunking: { maxChunkSize: 3000, overlap: 300 },
    flush: { batchSize: 20, intervalSeconds: 30 },
    compiler: { enabled: true, model: 'minimax-m2.7' },
    converter: { enabled: true, visionModel: 'gpt-4o-mini', pythonPath: 'python3' },
  };

  function mergeFeederConfig(stored) {
    const s = stored || {};
    return {
      enabled: s.enabled !== false,
      additionalWatchPaths: Array.isArray(s.additionalWatchPaths) ? s.additionalWatchPaths : [],
      excludePatterns: Array.isArray(s.excludePatterns) ? s.excludePatterns : [],
      chunking: {
        maxChunkSize: s.chunking?.maxChunkSize ?? FEEDER_DEFAULTS.chunking.maxChunkSize,
        overlap: s.chunking?.overlap ?? FEEDER_DEFAULTS.chunking.overlap,
      },
      flush: {
        batchSize: s.flush?.batchSize ?? FEEDER_DEFAULTS.flush.batchSize,
        intervalSeconds: s.flush?.intervalSeconds ?? FEEDER_DEFAULTS.flush.intervalSeconds,
      },
      compiler: {
        enabled: s.compiler?.enabled !== false,
        model: s.compiler?.model || FEEDER_DEFAULTS.compiler.model,
      },
      converter: {
        enabled: s.converter?.enabled !== false,
        visionModel: s.converter?.visionModel || FEEDER_DEFAULTS.converter.visionModel,
        pythonPath: s.converter?.pythonPath || FEEDER_DEFAULTS.converter.pythonPath,
      },
    };
  }

  router.get('/feeder', (req, res) => {
    const baseEngine = loadYaml(BASE_ENGINE_PATH);
    const feeder = mergeFeederConfig(baseEngine.feeder || {});
    // Also surface the auto-added watch paths that the orchestrator wires on startup
    const autoWatchPaths = [];
    if (process.env.COSMO_RUNTIME_DIR) {
      autoWatchPaths.push({
        path: path.join(process.env.COSMO_RUNTIME_DIR, 'ingestion', 'documents'),
        label: 'dropzone (auto)',
        source: 'orchestrator:ingestion-directory',
        readOnly: true,
      });
    }
    if (process.env.COSMO_WORKSPACE_PATH) {
      autoWatchPaths.push({
        path: process.env.COSMO_WORKSPACE_PATH,
        label: 'workspace (auto)',
        source: 'orchestrator:COSMO_WORKSPACE_PATH',
        readOnly: true,
      });
    }
    res.json({
      feeder,
      autoWatchPaths,
      configPath: BASE_ENGINE_PATH,
    });
  });

  router.put('/feeder', (req, res) => {
    const { feeder: input } = req.body || {};
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ ok: false, error: 'feeder object required' });
    }

    const baseEngine = loadYaml(BASE_ENGINE_PATH);
    const current = mergeFeederConfig(baseEngine.feeder || {});
    const incoming = mergeFeederConfig(input);

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

    // Write to base-engine.yaml
    baseEngine.feeder = {
      ...(baseEngine.feeder || {}),
      enabled: incoming.enabled,
      additionalWatchPaths: incoming.additionalWatchPaths,
      excludePatterns: incoming.excludePatterns,
      chunking: incoming.chunking,
      flush: incoming.flush,
      compiler: incoming.compiler,
      converter: incoming.converter,
    };
    saveYaml(BASE_ENGINE_PATH, baseEngine);

    res.json({ ok: true, applied, requiresRestart });
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
    res.json({ vibe });
  });

  router.put('/vibe', (req, res) => {
    const { vibe: input } = req.body || {};
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ ok: false, error: 'vibe object required' });
    }
    const configPath = path.join(home23Root, 'config', 'home.yaml');
    const homeConfig = loadYaml(configPath);
    if (!homeConfig.dashboard) homeConfig.dashboard = {};
    homeConfig.dashboard.vibe = mergeVibeConfig(input);
    saveYaml(configPath, homeConfig);
    res.json({ ok: true, vibe: homeConfig.dashboard.vibe, applied: ['vibe'], requiresRestart: [] });
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

  router.put('/tile-connections', (req, res) => {
    try {
      const { connections: input } = req.body || {};
      if (!input || !Array.isArray(input.connections)) {
        return res.status(400).json({ ok: false, error: 'connections.connections array required' });
      }

      const saved = tileService.saveConnectionsSettings(input);
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

module.exports = { createSettingsRouter };
