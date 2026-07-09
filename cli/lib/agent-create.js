/**
 * Home23 CLI — agent create command
 *
 * Creates a new agent instance with directories, config, identity files,
 * and regenerates ecosystem.config.cjs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { askWithDefault, askSecret, closeRL } from './prompts.js';
import { generateEcosystem } from './generate-ecosystem.js';
import { isSharedServiceName } from './shared-service-start.js';

const require = createRequire(import.meta.url);
const { buildAgentConfig, buildFeederConfig } = require('./agent-config-builder.cjs');

function findNextPorts(home23Root) {
  const instancesDir = join(home23Root, 'instances');
  if (!existsSync(instancesDir)) return { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 };

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

function getHome23Version(home23Root) {
  try {
    const pkg = JSON.parse(readFileSync(join(home23Root, 'package.json'), 'utf8'));
    return pkg.version || '0.6.0';
  } catch {
    return '0.6.0';
  }
}

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return yaml.load(readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function discoverAgentNames(home23Root) {
  const instancesDir = join(home23Root, 'instances');
  if (!existsSync(instancesDir)) return [];
  return readdirSync(instancesDir)
    .filter((name) => {
      const dir = join(instancesDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, 'config.yaml'));
    })
    .map((name) => {
      const config = loadYaml(join(instancesDir, name, 'config.yaml'));
      return {
        name,
        dashboardPort: Number(config?.ports?.dashboard) || Number.MAX_SAFE_INTEGER,
        enginePort: Number(config?.ports?.engine) || Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((a, b) => a.dashboardPort - b.dashboardPort || a.enginePort - b.enginePort || a.name.localeCompare(b.name))
    .map((agent) => agent.name);
}

function ensurePrimaryAgent(home23Root, newAgentName, existingAgentNames = []) {
  const configDir = join(home23Root, 'config');
  const configPath = join(configDir, 'home.yaml');
  mkdirSync(configDir, { recursive: true });
  const homeConfig = loadYaml(configPath);
  if (!homeConfig.home) homeConfig.home = {};

  const configured = String(homeConfig.home.primaryAgent || '').trim();
  if (configured) return null;

  const primaryAgent = existingAgentNames[0] || newAgentName;
  homeConfig.home.primaryAgent = primaryAgent;
  writeFileSync(configPath, yaml.dump(homeConfig, { lineWidth: 120 }), 'utf8');
  return primaryAgent;
}

function defaultPurpose(ownerName) {
  const owner = ownerName && ownerName !== 'owner' ? ownerName : 'me';
  return `Help ${owner} organize work, remember important context, and keep projects moving.`;
}

function expandPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

function pathLabel(filePath, seenLabels) {
  const base = basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
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
    const expanded = expandPath(value);
    if (!expanded) continue;
    const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
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

export async function runAgentCreate(home23Root, name, options = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error('Agent name must be lowercase alphanumeric with hyphens');
  }
  if (isSharedServiceName(`home23-${name}`)) {
    throw new Error(`Agent name "${name}" is reserved for a Home23 shared service`);
  }
  const instanceDir = join(home23Root, 'instances', name);
  const home23Version = getHome23Version(home23Root);
  const prompt = options.prompt || {};
  const promptWithDefault = prompt.askWithDefault || askWithDefault;
  const promptSecret = prompt.askSecret || askSecret;
  const closePrompts = prompt.close || closeRL;

  if (existsSync(instanceDir)) {
    console.error(`Error: Instance "${name}" already exists at ${instanceDir}`);
    process.exit(1);
  }

  // Find defaults from existing agents
  let defaultOwner = 'owner';
  let defaultTelegramId = '';
  let defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const existingAgentNames = discoverAgentNames(home23Root);
  const instancesDir = join(home23Root, 'instances');
  if (existsSync(instancesDir)) {
    for (const existing of existingAgentNames) {
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

  const displayName = await promptWithDefault('Agent display name', displayDefault);
  const ownerName = await promptWithDefault('Owner name', defaultOwner);
  const personalFacts = await promptWithDefault('Important facts this agent should know about you (optional)', '');
  const parsedPersonalFacts = parsePersonalFacts(personalFacts);
  const purpose = await promptWithDefault('What should this agent help with?', defaultPurpose(ownerName));
  const ingestInput = await promptWithDefault('Project folders to ingest now (comma-separated paths, optional)', '');
  const ownerTelegramId = await promptWithDefault('Owner Telegram ID', defaultTelegramId);
  const timezone = await promptWithDefault('Timezone', defaultTimezone);
  console.log('');
  const botToken = await promptSecret('Telegram bot token (from BotFather)');
  console.log('');
  const defaultModel = await promptWithDefault('Default chat model', 'kimi-k2.6');
  const defaultProvider = await promptWithDefault('Default provider', 'ollama-cloud');

  closePrompts();

  const ports = findNextPorts(home23Root);
  const ingestPaths = parseIngestPaths(options.ingestPaths ?? ingestInput);

  console.log('');
  console.log(`Creating instances/${name}/...`);

  // Create directories
  for (const dir of ['workspace', 'workspace/scripts', 'brain', 'conversations', 'conversations/sessions', 'logs', 'cron-runs']) {
    mkdirSync(join(instanceDir, dir), { recursive: true });
    console.log(`  ${dir.padEnd(16)} \u2713`);
  }

  // Write config.yaml
  const agentConfig = buildAgentConfig({
    name,
    displayName,
    ownerName,
    ownerTelegramId,
    personalFacts: parsedPersonalFacts,
    timezone,
    purpose,
    home23Version,
    provider: defaultProvider,
    model: defaultModel,
    instanceDir,
    ingestPaths,
    botToken,
    ports: {
      engine: ports.engine,
      dashboard: ports.dashboard,
      mcp: ports.mcp,
      bridge: ports.bridge,
    },
  });

  writeFileSync(join(instanceDir, 'config.yaml'), yaml.dump(agentConfig, { lineWidth: 120 }), 'utf8');
  console.log(`  config.yaml    \u2713 (ports: ${ports.engine}/${ports.dashboard}/${ports.mcp}/${ports.bridge})`);

  // Write feeder.yaml
  const feederConfig = buildFeederConfig(name);

  writeFileSync(join(instanceDir, 'feeder.yaml'), yaml.dump(feederConfig, { lineWidth: 120 }), 'utf8');
  console.log(`  feeder.yaml    \u2713`);

  // Write identity files from templates
  const templateVars = { displayName, name, ownerName, purpose };
  for (const file of ['SOUL.md', 'MISSION.md', 'HEARTBEAT.md', 'MEMORY.md', 'LEARNINGS.md', 'GOOD_LIFE.md', 'COSMO_RESEARCH.md', 'NOW.md', 'PLAYBOOK.md']) {
    const template = loadTemplate(home23Root, file);
    const content = renderTemplate(template, templateVars);
    writeFileSync(join(instanceDir, 'workspace', file), content, 'utf8');
    console.log(`  ${file.padEnd(16)} \u2713`);
  }

  // Write domain surfaces for Situational Awareness Engine (Step 20)
  const today = new Date().toISOString().split('T')[0];
  const surfaces = {
    'TOPOLOGY.md': `# House Topology\n\n_No services registered yet. The curator cycle will populate this as the agent learns about the house._\n\n_Last verified: ${new Date().toISOString().split('T')[0]}. Source: initial setup._\n`,
    'PROJECTS.md': projectSurface(today, ingestPaths),
    'PERSONAL.md': personalSurface(ownerName, parsedPersonalFacts),
    'DOCTRINE.md': `# Doctrine — How We Work\n\n## Conventions\n- Engine is JS. Harness is TS. Two languages, one system.\n- NEVER pm2 delete/stop all — scope commands to specific process names.\n\n_Curator-maintained. Includes boundaries and operating constraints._\n`,
    'RECENT.md': `# Recent Activity (Last 48 Hours)\n\n## ${today}\n\n### Agent created\n- ${displayName} initialized with Home23\n- Purpose: ${purpose}\n- Starter ingestion paths: ${ingestPaths.length || 0}\n- Situational awareness engine active\n\n_Auto-generated. Entries older than 48h drop from assembly loading._\n`,
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

  const primaryAgent = ensurePrimaryAgent(home23Root, name, existingAgentNames);
  if (primaryAgent) {
    console.log(`  home.yaml      \u2713 (primary agent: ${primaryAgent})`);
  }

  // Regenerate ecosystem.config.cjs
  console.log('');
  generateEcosystem(home23Root);

  console.log('');
  console.log(`Agent "${name}" is ready.`);
  console.log('');
  console.log('Next steps:');
  console.log(`  • Start: node cli/home23.js start ${name}`);
  console.log(`  • Open:  http://localhost:${ports.dashboard}/home23`);
  console.log(`  • Add more files later: Settings -> Feeder`);
  console.log('');
}
