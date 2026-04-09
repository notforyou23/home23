/**
 * Evobrew Config Generator
 *
 * Reads Home23's home.yaml, secrets.yaml, and instances/ to produce
 * evobrew's config.json. No encryption — Home23 manages secrets separately.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  return yaml.load(readFileSync(filePath, 'utf8')) || {};
}

export function generateEvobrewConfig(home23Root) {
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));
  const secrets = loadYaml(join(home23Root, 'config', 'secrets.yaml'));
  const instancesDir = join(home23Root, 'instances');

  // Scan instances for agents
  const agents = [];
  if (existsSync(instancesDir)) {
    for (const name of readdirSync(instancesDir).sort()) {
      const agentConfigPath = join(instancesDir, name, 'config.yaml');
      if (!existsSync(agentConfigPath)) continue;
      const agentConfig = loadYaml(agentConfigPath);
      const brainPath = join(instancesDir, name, 'brain');

      // Each agent's harness bridge runs on its bridge port
      const bridgePort = agentConfig.ports?.bridge ?? (4610 + agents.length * 10);
      const bridgeToken = secrets.agents?.[name]?.bridgeToken ?? '';

      agents.push({
        id: name,
        name: agentConfig.agent?.displayName || name,
        url: `http://localhost:${bridgePort}`,
        endpoint: '/api/chat',
        api_key: bridgeToken,
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

  // Build evobrew config
  const config = {
    _generated: true,
    _source: 'Home23 config generator — do not edit manually',

    providers: {
      anthropic: {
        api_key: secrets.providers?.anthropic?.apiKey || '',
        oauth: false,
      },
      openai: {
        api_key: secrets.providers?.openai?.apiKey || '',
      },
      xai: {
        api_key: secrets.providers?.xai?.apiKey || '',
      },
      ollama: {
        url: homeConfig.providers?.['ollama-local']?.baseUrl || 'http://127.0.0.1:11434',
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
        // Scanner looks for <dir>/<subdir>/state.json.gz, so point at instance dirs (not brain/ directly)
        directories: agents.map(a => join(home23Root, 'instances', a.id)),
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
  console.log(`[evobrew] ${config.providers.local_agents.length} agent(s) registered`);

  return configPath;
}
