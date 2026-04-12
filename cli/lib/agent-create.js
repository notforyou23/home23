/**
 * Home23 CLI — agent create command
 *
 * Creates a new agent instance with directories, config, identity files,
 * and regenerates ecosystem.config.cjs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { askWithDefault, askSecret, closeRL } from './prompts.js';
import { generateEcosystem } from './generate-ecosystem.js';

function findNextPorts(home23Root) {
  const instancesDir = join(home23Root, 'instances');
  if (!existsSync(instancesDir)) return { engine: 5001, dashboard: 5002, mcp: 5003 };

  let maxBase = 4991; // so first agent gets 5001
  for (const name of readdirSync(instancesDir)) {
    const configPath = join(instancesDir, name, 'config.yaml');
    if (!existsSync(configPath)) continue;
    try {
      const config = yaml.load(readFileSync(configPath, 'utf8'));
      const enginePort = config?.ports?.engine || 0;
      if (enginePort > maxBase) maxBase = enginePort;
    } catch { /* skip */ }
  }

  const base = Math.ceil((maxBase + 1) / 10) * 10 + 1;
  return { engine: base, dashboard: base + 1, mcp: base + 2, bridge: base + 3 };
}

function loadTemplate(home23Root, filename) {
  const templatePath = join(home23Root, 'cli', 'templates', filename);
  if (!existsSync(templatePath)) return `# ${filename.replace('.md', '')}\n`;
  return readFileSync(templatePath, 'utf8');
}

function renderTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function addBotTokenToSecrets(home23Root, agentName, botToken) {
  const secretsPath = join(home23Root, 'config', 'secrets.yaml');
  let content = '';
  if (existsSync(secretsPath)) {
    content = readFileSync(secretsPath, 'utf8');
  }

  // Add or update agents section
  if (content.includes(`\nagents:`)) {
    // Agents section exists — append under it
    const agentEntry = `  ${agentName}:\n    telegram:\n      botToken: "${botToken}"`;
    // Check if this agent already exists
    if (content.includes(`  ${agentName}:`)) {
      // Replace existing entry (simple approach: regex)
      content = content.replace(
        new RegExp(`  ${agentName}:\\n    telegram:\\n      botToken: "[^"]*"`),
        agentEntry
      );
    } else {
      content = content.trimEnd() + '\n' + agentEntry + '\n';
    }
  } else {
    // No agents section — add it
    content = content.trimEnd() + `\n\nagents:\n  ${agentName}:\n    telegram:\n      botToken: "${botToken}"\n`;
  }

  writeFileSync(secretsPath, content, 'utf8');
}

export async function runAgentCreate(home23Root, name) {
  const instanceDir = join(home23Root, 'instances', name);

  if (existsSync(instanceDir)) {
    console.error(`Error: Instance "${name}" already exists at ${instanceDir}`);
    process.exit(1);
  }

  // Find defaults from existing agents
  let defaultOwner = 'owner';
  let defaultTelegramId = '';
  let defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const instancesDir = join(home23Root, 'instances');
  if (existsSync(instancesDir)) {
    for (const existing of readdirSync(instancesDir)) {
      const configPath = join(instancesDir, existing, 'config.yaml');
      if (!existsSync(configPath)) continue;
      try {
        const config = yaml.load(readFileSync(configPath, 'utf8'));
        if (config?.agent?.owner?.name) defaultOwner = config.agent.owner.name;
        if (config?.agent?.owner?.telegramId) defaultTelegramId = config.agent.owner.telegramId;
        if (config?.agent?.timezone) defaultTimezone = config.agent.timezone;
        break; // Use first found
      } catch { /* skip */ }
    }
  }

  const displayDefault = name.charAt(0).toUpperCase() + name.slice(1);

  console.log('');
  console.log(`Home23 — Create Agent: ${name}`);
  console.log('────────────────────────────');
  console.log('');

  const displayName = await askWithDefault('Agent display name', displayDefault);
  const ownerName = await askWithDefault('Owner name', defaultOwner);
  const ownerTelegramId = await askWithDefault('Owner Telegram ID', defaultTelegramId);
  const timezone = await askWithDefault('Timezone', defaultTimezone);
  console.log('');
  const botToken = await askSecret('Telegram bot token (from BotFather)');
  console.log('');
  const defaultModel = await askWithDefault('Default chat model', 'kimi-k2.5');
  const defaultProvider = await askWithDefault('Default provider', 'ollama-cloud');

  closeRL();

  const ports = findNextPorts(home23Root);

  console.log('');
  console.log(`Creating instances/${name}/...`);

  // Create directories
  for (const dir of ['workspace', 'brain', 'conversations', 'conversations/sessions', 'logs', 'cron-runs']) {
    mkdirSync(join(instanceDir, dir), { recursive: true });
    console.log(`  ${dir.padEnd(16)} \u2713`);
  }

  // Write config.yaml
  const agentConfig = {
    agent: {
      name,
      displayName,
      owner: { name: ownerName, telegramId: ownerTelegramId || undefined },
      timezone,
      maxSubAgents: 3,
    },
    ports: {
      engine: ports.engine,
      dashboard: ports.dashboard,
      mcp: ports.mcp,
      bridge: ports.bridge,
    },
    engine: {
      thought: 'minimax-m2.7',
      consolidation: 'minimax-m2.7',
      dreaming: 'minimax-m2.7',
      query: 'minimax-m2.7',
    },
    channels: {
      telegram: {
        enabled: !!botToken,
        streaming: 'partial',
        dmPolicy: 'open',
        groupPolicy: 'restricted',
        groups: {},
        ackReaction: true,
      },
    },
    system: { name: 'home23', version: '0.1.0', workspace: 'workspace' },
    chat: {
      provider: defaultProvider,
      model: defaultModel,
      defaultProvider,
      defaultModel,
      maxTokens: 4096,
      temperature: 0.7,
      historyDepth: 20,
      historyBudget: 400000,
      sessionGapMs: 1800000,
      memorySearch: { enabled: false, timeoutMs: 10000, topK: 5 },
      identityFiles: ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'LEARNINGS.md', 'COSMO_RESEARCH.md'],
      heartbeatRefreshMs: 60000,
    },
    sessions: {
      threadBindings: { enabled: true, idleHours: 24 },
      messageQueue: { mode: 'collect', debounceMs: 3000, adaptiveDebounce: true, cap: 10, overflowStrategy: 'summarize', queueDuringRun: true },
    },
    scheduler: { timezone, jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' },
    sibling: {
      enabled: false, name: '', remoteUrl: '', token: '',
      rateLimits: { maxPerMinute: 5, retries: 2, dedupWindowSeconds: 300 },
      ackMode: false,
      bridgeChat: { enabled: false, dbPath: '', telegramBotToken: '', telegramTargetId: '' },
    },
    acp: { enabled: false, defaultAgent: '', allowedAgents: [], permissionMode: 'ask' },
    browser: { enabled: true, headless: true, cdpUrl: 'http://localhost:9222' },
    tts: { enabled: false, auto: 'off', provider: '', apiKey: '', voiceId: '', modelId: '' },
  };

  writeFileSync(join(instanceDir, 'config.yaml'), yaml.dump(agentConfig, { lineWidth: 120 }), 'utf8');
  console.log(`  config.yaml    \u2713 (ports: ${ports.engine}/${ports.dashboard}/${ports.mcp}/${ports.bridge})`);

  // Write feeder.yaml
  const feederConfig = {
    member: name,
    state_file: `../instances/${name}/brain/state.json.gz`,
    watch: [{ path: `../instances/${name}/workspace`, label: 'workspace', glob: '*.md' }],
    ollama: { endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text', dims: 768 },
    flush_interval_seconds: 300,
    flush_batch_size: 20,
  };

  writeFileSync(join(instanceDir, 'feeder.yaml'), yaml.dump(feederConfig, { lineWidth: 120 }), 'utf8');
  console.log(`  feeder.yaml    \u2713`);

  // Write identity files from templates
  const templateVars = { displayName, name, ownerName };
  for (const file of ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'MEMORY.md', 'LEARNINGS.md', 'COSMO_RESEARCH.md']) {
    const template = loadTemplate(home23Root, file);
    const content = renderTemplate(template, templateVars);
    writeFileSync(join(instanceDir, 'workspace', file), content, 'utf8');
    console.log(`  ${file.padEnd(16)} \u2713`);
  }

  // Write domain surfaces for Situational Awareness Engine (Step 20)
  const surfaces = {
    'TOPOLOGY.md': `# House Topology\n\n_No services registered yet. The curator cycle will populate this as the agent learns about the house._\n\n_Last verified: ${new Date().toISOString().split('T')[0]}. Source: initial setup._\n`,
    'PROJECTS.md': `# Active Projects\n\n_No projects tracked yet. Use promote_to_memory or conversation extraction to add projects._\n\n_Curator-maintained. Last updated: ${new Date().toISOString().split('T')[0]}._\n`,
    'PERSONAL.md': `# Personal Context — ${ownerName}\n\n## Profile\n- Owner: ${ownerName}\n\n_Personal memory. Surface only on direct relevance. Curator-maintained._\n`,
    'DOCTRINE.md': `# Doctrine — How We Work\n\n## Conventions\n- Engine is JS. Harness is TS. Two languages, one system.\n- NEVER pm2 delete/stop all — scope commands to specific process names.\n\n_Curator-maintained. Includes boundaries and operating constraints._\n`,
    'RECENT.md': `# Recent Activity (Last 48 Hours)\n\n## ${new Date().toISOString().split('T')[0]}\n\n### Agent created\n- ${displayName} initialized with Home23\n- Situational awareness engine active\n\n_Auto-generated. Entries older than 48h drop from assembly loading._\n`,
  };

  for (const [file, content] of Object.entries(surfaces)) {
    writeFileSync(join(instanceDir, 'workspace', file), content, 'utf8');
    console.log(`  ${file.padEnd(16)} \u2713 (surface)`);
  }

  // Write empty brain data files for Step 20
  mkdirSync(join(instanceDir, 'brain'), { recursive: true });
  writeFileSync(join(instanceDir, 'brain', 'memory-objects.json'), JSON.stringify({ objects: [] }, null, 2));
  writeFileSync(join(instanceDir, 'brain', 'problem-threads.json'), JSON.stringify({ threads: [] }, null, 2));
  writeFileSync(join(instanceDir, 'brain', 'trigger-index.json'), JSON.stringify({ triggers: [] }, null, 2));
  console.log(`  brain data     \u2713 (memory objects, threads, triggers)`);

  // Add bot token to secrets.yaml (if provided)
  if (botToken) {
    addBotTokenToSecrets(home23Root, name, botToken);
    console.log(`  secrets.yaml   \u2713 (bot token added)`);
  }

  // Regenerate ecosystem.config.cjs
  console.log('');
  generateEcosystem(home23Root);

  console.log('');
  console.log(`Agent "${name}" is ready. Start it:`);
  console.log(`  node cli/home23.js start ${name}`);
  console.log('');
}
