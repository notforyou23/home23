/**
 * Evobrew Config Generator
 *
 * Reads Home23's home.yaml, secrets.yaml, and instances/ to produce
 * evobrew's config.json. API keys are NOT written — PM2 env vars handle that.
 * This file provides structure: agents, brains, allowed models, ports.
 *
 * Regenerated on every engine start (not just first start).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  return yaml.load(readFileSync(filePath, 'utf8')) || {};
}

function loadJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function loadExternalBrainDirectories(home23Root) {
  const configPaths = [
    join(homedir(), '.evobrew', 'config.json'),
    join(homedir(), '.cosmo2.3', 'config.json'),
  ];

  const configuredDirs = [];
  for (const configPath of configPaths) {
    const config = loadJson(configPath);
    const dirs = Array.isArray(config?.features?.brains?.directories)
      ? config.features.brains.directories
      : Array.isArray(config?.brains?.directories)
        ? config.brains.directories
        : [];

    for (const dir of dirs) {
      const trimmed = String(dir || '').trim();
      if (trimmed) configuredDirs.push(resolve(trimmed));
    }
  }

  const envDirs = [process.env.COSMO_BRAIN_DIRS, process.env.BRAIN_DIRS]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(dir => String(dir || '').trim())
    .filter(Boolean)
    .map(dir => resolve(dir));

  const allDirs = [...configuredDirs, ...envDirs];
  const uniqueDirs = [];
  const seen = new Set();

  for (const dir of allDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    uniqueDirs.push(dir);
  }

  return uniqueDirs.filter(dir => dir !== home23Root);
}

export function generateEvobrewConfig(home23Root) {
  // Resolve to absolute — critical for evobrew which runs from a different cwd
  home23Root = resolve(home23Root);
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));
  const instancesDir = join(home23Root, 'instances');
  const externalBrainDirs = loadExternalBrainDirectories(home23Root);

  // Scan instances for agents
  const agents = [];
  if (existsSync(instancesDir)) {
    for (const name of readdirSync(instancesDir).sort()) {
      const agentConfigPath = join(instancesDir, name, 'config.yaml');
      if (!existsSync(agentConfigPath)) continue;
      const agentConfig = loadYaml(agentConfigPath);
      const brainPath = join(instancesDir, name, 'brain');
      const bridgePort = agentConfig.ports?.bridge ?? (5004 + agents.length * 10);

      agents.push({
        id: name,
        name: agentConfig.agent?.displayName || name,
        url: `http://localhost:${bridgePort}`,
        endpoint: '/api/chat',
        api_key: '',
        brainPath,
        enabled: true,
        capabilities: {
          maxOutputTokens: 64000,
          contextWindow: 128000,
        },
      });
    }
  }

  // Scan cosmo23 runs for research brains
  const cosmo23RunsDir = join(home23Root, 'cosmo23', 'runs');
  const researchBrains = {};
  if (existsSync(cosmo23RunsDir)) {
    for (const name of readdirSync(cosmo23RunsDir).sort()) {
      const stateFile = join(cosmo23RunsDir, name, 'state.json.gz');
      if (existsSync(stateFile)) {
        researchBrains[name] = join(cosmo23RunsDir, name);
      }
    }
  }

  // Build allowed models from home.yaml providers.*.defaultModels
  const providers = homeConfig.providers || {};
  const configuredPrimaryAgent = String(homeConfig?.home?.primaryAgent || '').trim();
  const allowedModels = {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (providerConfig?.defaultModels?.length) {
      allowedModels[providerId] = providerConfig.defaultModels;
    }
  }

  const managedBrainDirs = [
    ...agents.map(a => join(home23Root, 'instances', a.id)),
    ...(existsSync(cosmo23RunsDir) ? [cosmo23RunsDir] : []),
  ].map(dir => resolve(dir));

  const brainDirectories = [];
  const seenBrainDirs = new Set();
  for (const dir of [...managedBrainDirs, ...externalBrainDirs]) {
    if (!dir || seenBrainDirs.has(dir)) continue;
    seenBrainDirs.add(dir);
    brainDirectories.push(dir);
  }

  // Build evobrew config — NO API KEYS (PM2 env vars handle auth)
  const config = {
    _generated: true,
    _generatedAt: new Date().toISOString(),
    _source: 'Home23 config generator — do not edit manually. Regenerated on every start.',
    _home23: true,

    providers: {
      // No API keys — PM2 injects ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
      anthropic: { oauth: false },
      minimax: {
        url: providers.minimax?.baseUrl || 'https://api.minimax.io/anthropic',
      },
      openai: {},
      xai: {},
      ollama: {
        url: providers['ollama-local']?.baseUrl || 'http://127.0.0.1:11434',
      },
      'ollama-cloud': {
        url: providers['ollama-cloud']?.baseUrl || 'https://ollama.com/v1',
      },
      local_agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        url: a.url,
        endpoint: a.endpoint,
        api_key: a.api_key,
        enabled: a.enabled,
        capabilities: a.capabilities,
      })),
    },

    // Model allow-list from home.yaml — evobrew filters to these only
    allowedModels,

    // Default selections from home.yaml chat section
    defaults: {
      provider: homeConfig.chat?.defaultProvider || '',
      model: homeConfig.chat?.defaultModel || '',
    },

    brain: {
      defaultPath: agents.find(a => a.id === configuredPrimaryAgent)?.brainPath
        || (agents.length > 0 ? agents[0].brainPath : ''),
      agentBrains: Object.fromEntries(
        agents.map(a => [a.id, a.brainPath])
      ),
      researchBrains,
    },

    features: {
      brains: {
        enabled: true,
        directories: brainDirectories,
      },
    },

    server: {
      port: homeConfig.evobrew?.port ?? 3405,
      host: '0.0.0.0',
    },

    security: {
      profile: 'local',
    },

    terminal: {
      enabled: true,
      maxSessions: 5,
    },
  };

  return config;
}

export function writeEvobrewConfig(home23Root) {
  const config = generateEvobrewConfig(home23Root);
  const configDir = join(home23Root, 'evobrew');
  const configPath = join(configDir, 'config.json');

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[evobrew] Config written to ${configPath}`);
  console.log(`[evobrew]   ${config.providers.local_agents.length} agent(s), ${Object.keys(config.brain.researchBrains).length} research brain(s)`);
  console.log(`[evobrew]   Brain roots: ${config.features?.brains?.directories?.length || 0}`);
  console.log(`[evobrew]   Allowed models: ${Object.entries(config.allowedModels).map(([p, m]) => `${p}(${m.length})`).join(', ')}`);

  return configPath;
}
