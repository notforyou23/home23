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
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  return yaml.load(readFileSync(filePath, 'utf8')) || {};
}

export function generateEvobrewConfig(home23Root) {
  // Resolve to absolute — critical for evobrew which runs from a different cwd
  home23Root = resolve(home23Root);
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));
  const instancesDir = join(home23Root, 'instances');

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
  const allowedModels = {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (providerConfig?.defaultModels?.length) {
      allowedModels[providerId] = providerConfig.defaultModels;
    }
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
      defaultPath: agents.length > 0 ? agents[0].brainPath : '',
      agentBrains: Object.fromEntries(
        agents.map(a => [a.id, a.brainPath])
      ),
      researchBrains,
    },

    features: {
      brains: {
        enabled: true,
        directories: [
          ...agents.map(a => join(home23Root, 'instances', a.id)),
          ...(existsSync(cosmo23RunsDir) ? [cosmo23RunsDir] : []),
        ],
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
  console.log(`[evobrew]   Allowed models: ${Object.entries(config.allowedModels).map(([p, m]) => `${p}(${m.length})`).join(', ')}`);

  return configPath;
}
