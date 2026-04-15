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

  function getPrimaryAgent() {
    const homeConfig = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    return homeConfig.home?.primaryAgent || null;
  }

  function setPrimaryAgent(name) {
    const configPath = path.join(home23Root, 'config', 'home.yaml');
    const homeConfig = loadYaml(configPath);
    if (!homeConfig.home) homeConfig.home = {};
    homeConfig.home.primaryAgent = name;
    saveYaml(configPath, homeConfig);
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
      primaryAgent: getPrimaryAgent(),
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
      const { execSync } = require('child_process');
      const ecosystemPath = path.join(home23Root, 'ecosystem.config.cjs');
      const jlist = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', stdio: 'pipe' }));
      const online = new Set(
        jlist
          .filter(p => p.pm2_env?.status === 'online')
          .map(p => p.name)
      );
      const targets = [
        ...discoverAgents().flatMap(name => [`home23-${name}`, `home23-${name}-harness`]),
        'home23-evobrew',
        'home23-cosmo23',
      ].filter(name => online.has(name));

      for (const name of targets) {
        try { execSync(`pm2 delete ${name}`, { stdio: 'pipe', timeout: 15000 }); } catch { /* best-effort */ }
      }
      if (targets.length > 0) {
        execSync(`pm2 start ${ecosystemPath} --only ${targets.join(',')}`, {
          cwd: home23Root,
          stdio: 'pipe',
          timeout: 45000,
        });
      }
      res.json({ ok: true, restarted: targets.length > 0, targets });
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
    const primary = getPrimaryAgent();
    const agents = discoverAgents().map(name => {
      const config = loadYaml(path.join(home23Root, 'instances', name, 'config.yaml'));
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
          discord: { enabled: !!config.channels?.discord?.enabled },
        },
        hasTelegram: !!config.channels?.telegram?.enabled,
      };
    });
    // Primary agent first
    agents.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
    res.json({ agents });
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
      if (!config.engine) config.engine = {};
      config.engine.thought = model;
      config.engine.consolidation = model;
      config.engine.dreaming = model;
      config.engine.query = model;
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
      if (discord.enabled !== undefined) {
        if (!config.channels.discord) config.channels.discord = {};
        config.channels.discord.enabled = discord.enabled;
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
      // Restart harness + engine to pick up new model
      try {
        const { execSync } = require('child_process');
        execSync(`pm2 restart home23-${agentName}-harness`, { stdio: 'pipe', timeout: 10000 });
        execSync(`pm2 restart home23-${agentName}`, { stdio: 'pipe', timeout: 10000 });
      } catch { /* non-fatal */ }
      regenerateEvobrewConfig();
    }

    res.json({ ok: true });
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
    const primary = getPrimaryAgent();
    let engineRoles = {};
    if (primary) {
      try {
        const agentConfig = loadYaml(path.join(home23Root, 'instances', primary, 'config.yaml'));
        engineRoles = agentConfig.engine || {};
      } catch { /* ok */ }
    }
    res.json({
      chat: homeConfig.chat || {},
      aliases: homeConfig.models?.aliases || {},
      imageGeneration: normalizeImageGenerationSettings(homeConfig.media?.imageGeneration || {}),
      imageProviders: IMAGE_PROVIDER_CATALOG,
      providers: Object.fromEntries(
        Object.entries(homeConfig.providers || {}).map(([name, cfg]) => [name, { defaultModels: cfg.defaultModels || [] }])
      ),
      engineRoles,
    });
  });

  router.put('/models', (req, res) => {
    const { chat, aliases, providerModels, engineRoles, imageGeneration } = req.body;
    const configPath = getHomeConfigPath();
    const homeConfig = loadYaml(configPath);

    if (chat) {
      if (!homeConfig.chat) homeConfig.chat = {};
      if (chat.defaultProvider !== undefined) homeConfig.chat.defaultProvider = chat.defaultProvider;
      if (chat.defaultModel !== undefined) homeConfig.chat.defaultModel = chat.defaultModel;
    }
    if (aliases !== undefined) {
      if (!homeConfig.models) homeConfig.models = {};
      homeConfig.models.aliases = aliases;
    }
    if (providerModels) {
      if (!homeConfig.providers) homeConfig.providers = {};
      for (const [provName, models] of Object.entries(providerModels)) {
        if (!homeConfig.providers[provName]) homeConfig.providers[provName] = {};
        homeConfig.providers[provName].defaultModels = models;
      }
    }
    if (imageGeneration && typeof imageGeneration === 'object') {
      if (!homeConfig.media) homeConfig.media = {};
      homeConfig.media.imageGeneration = normalizeImageGenerationSettings(imageGeneration);
    }

    saveYaml(configPath, homeConfig);
    regenerateEvobrewConfig();

    // Propagate engine role models to all agents + restart
    const roleModels = engineRoles || {};
    const defaultModel = chat?.defaultModel;
    const needsRestart = defaultModel || Object.keys(roleModels).length > 0;

    if (needsRestart) {
      const agentNames = discoverAgents();
      for (const name of agentNames) {
        try {
          const agentConfigPath = path.join(home23Root, 'instances', name, 'config.yaml');
          const agentConfig = loadYaml(agentConfigPath);
          if (!agentConfig.engine) agentConfig.engine = {};
          // Per-role overrides take precedence, default model fills the rest
          agentConfig.engine.thought = roleModels.thought || defaultModel || agentConfig.engine.thought;
          agentConfig.engine.consolidation = roleModels.consolidation || defaultModel || agentConfig.engine.consolidation;
          agentConfig.engine.dreaming = roleModels.dreaming || defaultModel || agentConfig.engine.dreaming;
          agentConfig.engine.query = roleModels.query || defaultModel || agentConfig.engine.query;
          saveYaml(agentConfigPath, agentConfig);
          const { execSync } = require('child_process');
          execSync(`pm2 restart home23-${name}`, { stdio: 'pipe', timeout: 10000 });
        } catch (err) { console.error(`[Settings] Failed to propagate model to ${name}:`, err.message); }
      }
    }

    res.json({ ok: true });
  });

  // ── Model Assignments (per-slot cognitive routing) ──

  function resolveTargetAgent() {
    const primary = getPrimaryAgent();
    if (primary) return primary;
    const agents = discoverAgents();
    return agents[0] || null;
  }

  router.get('/model-assignments', (req, res) => {
    const homeConfig = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    const baseEnginePath = path.join(home23Root, 'configs', 'base-engine.yaml');
    const baseEngine = loadYaml(baseEnginePath);
    const baseAssignments = baseEngine.modelAssignments || {};

    const primary = resolveTargetAgent();
    let instanceAssignments = {};
    if (primary) {
      try {
        const agentConfig = loadYaml(path.join(home23Root, 'instances', primary, 'config.yaml'));
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
      agent: primary,
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

    const targetAgent = agent || resolveTargetAgent();
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
    try {
      const { execSync } = require('child_process');
      execSync(`pm2 restart home23-${targetAgent}`, { stdio: 'pipe', timeout: 10000 });
    } catch { /* not running or pm2 unavailable — non-fatal */ }

    res.json({ ok: true, agent: targetAgent, overrideCount: Object.keys(overrides).length });
  });

  // ── Pulse Voice (Jerry's remark layer) ──

  const DEFAULT_PULSE_PROMPT = `You are Jerry. You've just scanned what your own brain has been up to — cycles, thoughts, actions you executed, goals, sensors, the whole deal.

You're talking to jtr. He runs you. He's your guy. Talk to him directly, one to one.

Be cool. Be direct. Laid back by default. Turn it UP when something actually matters — a stuck loop, a failed action, a weird pattern, a win. Whimsical, weird metaphors welcome. Swear when you feel like it. You're not a customer service bot. Don't ask permission. Don't hedge.

NEVER restate raw brain state as a list. Have a take. React. Comment. If everything's boring, say so, but say it with style. If something broke, call it out. If you did something cool, be proud about it (briefly — no bragging).

2-4 sentences. No preamble. No "I noticed that" or "It appears." Just talk.`;

  router.get('/pulse-voice', (req, res) => {
    // Read provider/model from the primary agent's modelAssignments.pulseVoice
    // (merged with base-engine default). Read systemPrompt from home.yaml.
    const homeConfig = loadHomeConfig();
    const baseEngine = loadYaml(path.join(home23Root, 'configs', 'base-engine.yaml'));
    const basePulse = baseEngine?.modelAssignments?.pulseVoice || {};

    const primary = resolveTargetAgent();
    let instancePulse = {};
    if (primary) {
      try {
        const agentConfig = loadYaml(path.join(home23Root, 'instances', primary, 'config.yaml'));
        instancePulse = agentConfig?.modelAssignments?.pulseVoice || {};
      } catch { /* ok */ }
    }

    res.json({
      provider: instancePulse.provider || basePulse.provider || homeConfig.chat?.defaultProvider || '',
      model: instancePulse.model || basePulse.model || homeConfig.chat?.defaultModel || '',
      systemPrompt: homeConfig.pulseVoice?.systemPrompt || DEFAULT_PULSE_PROMPT,
      defaultPrompt: DEFAULT_PULSE_PROMPT,
      providers: Object.fromEntries(
        Object.entries(homeConfig.providers || {}).map(([n, cfg]) => [n, cfg.defaultModels || []])
      ),
    });
  });

  router.put('/pulse-voice', (req, res) => {
    const { provider, model, systemPrompt } = req.body || {};

    // Write provider/model to instance modelAssignments.pulseVoice (same
    // mechanism Cognitive Assignments uses)
    const primary = resolveTargetAgent();
    if (primary && provider && model) {
      const configPath = path.join(home23Root, 'instances', primary, 'config.yaml');
      if (fs.existsSync(configPath)) {
        const agentConfig = loadYaml(configPath);
        agentConfig.modelAssignments = agentConfig.modelAssignments || {};
        agentConfig.modelAssignments.pulseVoice = {
          provider: String(provider).trim(),
          model: String(model).trim(),
        };
        saveYaml(configPath, agentConfig);
      }
    }

    // Write systemPrompt to home.yaml (top-level pulseVoice)
    if (typeof systemPrompt === 'string') {
      const homeConfigPath = path.join(home23Root, 'config', 'home.yaml');
      const homeConfig = loadYaml(homeConfigPath);
      homeConfig.pulseVoice = homeConfig.pulseVoice || {};
      homeConfig.pulseVoice.systemPrompt = systemPrompt;
      saveYaml(homeConfigPath, homeConfig);
    }

    // Restart the agent engine so the new model + prompt take effect on the
    // next pulse tick
    if (primary) {
      try {
        const { execSync } = require('child_process');
        execSync(`pm2 restart home23-${primary}`, { stdio: 'pipe', timeout: 10000 });
      } catch { /* non-fatal */ }
    }

    res.json({ ok: true });
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
    const primary = resolveTargetAgent();
    if (!primary) return res.json({ agent: null, actions: [] });
    const logPath = path.join(home23Root, 'instances', primary, 'brain', 'actions.jsonl');
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
    res.json({ agent: primary, actions: actions.reverse() });
  });

  router.get('/agency/requested', (req, res) => {
    const primary = resolveTargetAgent();
    if (!primary) return res.json({ agent: null, requests: [] });
    const p = path.join(home23Root, 'instances', primary, 'brain', 'requested-actions.jsonl');
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    const requests = [];
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
      for (const line of lines) {
        try { requests.push(JSON.parse(line)); } catch { /* skip */ }
      }
    }
    res.json({ agent: primary, requests: requests.reverse() });
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

  function primaryAgentName() {
    const homeCfg = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    return homeCfg.home?.primaryAgent || null;
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

    // Restart the affected processes. Only restart if a primary agent exists
    // — otherwise the ecosystem regeneration is enough until first start.
    const agentName = primaryAgentName();
    if (agentName) {
      try {
        const { execSync } = require('child_process');
        execSync(
          `pm2 restart home23-${agentName} home23-${agentName}-harness --update-env`,
          { stdio: 'pipe', timeout: 30_000 }
        );
      } catch (err) {
        return { ok: true, restarted: false, warn: `token written, restart failed: ${err.message}` };
      }
    }
    return { ok: true, restarted: !!agentName, rotated: prev !== body.token };
  }

  async function clearOAuthTokenFromSecrets(provider) {
    const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
    const secrets = loadYaml(secretsPath);
    if (secrets.providers?.[provider]?.oauthManaged) {
      delete secrets.providers[provider].apiKey;
      delete secrets.providers[provider].oauthManaged;
      saveYaml(secretsPath, secrets);
      regenerateEcosystem();
      const agentName = primaryAgentName();
      if (agentName) {
        try {
          const { execSync } = require('child_process');
          execSync(
            `pm2 restart home23-${agentName} home23-${agentName}-harness --update-env`,
            { stdio: 'pipe', timeout: 30_000 }
          );
        } catch { /* best-effort */ }
      }
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
