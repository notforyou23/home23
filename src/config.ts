/**
 * Home23 — Configuration Loader
 *
 * Three-layer merge: config/home.yaml ← instances/{agent}/config.yaml ← config/secrets.yaml
 * Deep merge — agent values override home defaults, secrets overlay on top.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, join } from 'node:path';
import yaml from 'js-yaml';
import type { HomeConfig, IdentityLayerConfig, EmbeddedAgentConfig } from './types.js';
import { validateReasoningEffortConfig } from './agent/reasoning-effort.js';
import type { ModelAliases } from './agent/model-resolution.js';
import { compileProjectWriteRoots } from './agent/tools/project-write-roots.js';

const PACKAGED_HOME23_ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { resolveAgentInstancePaths } = require('../shared/agent-instance-paths.cjs');

function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const targetVal = result[key];
    const sourceVal = source[key];
    if (
      targetVal && sourceVal &&
      typeof targetVal === 'object' && typeof sourceVal === 'object' &&
      !Array.isArray(targetVal) && !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

function loadYaml(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8');
  return (yaml.load(content) as Record<string, unknown>) ?? {};
}

function normalizeEmbeddedAgentLayers(embeddedAgent?: EmbeddedAgentConfig): IdentityLayerConfig[] | undefined {
  if (!embeddedAgent) return undefined;

  const identity = Array.isArray(embeddedAgent.identity)
    ? embeddedAgent.identity
    : [embeddedAgent.identity];

  const shared = embeddedAgent.shared ?? [];
  const layers = [...identity, ...shared]
    .filter((layer) => layer?.basePath && Array.isArray(layer.files) && layer.files.length > 0)
    .map((layer) => ({ basePath: layer.basePath, files: layer.files }));

  return layers.length > 0 ? layers : undefined;
}

export function getHome23Root(): string {
  const configured = process.env.HOME23_ROOT;
  if (configured === undefined || configured === '') return PACKAGED_HOME23_ROOT;
  if (!isAbsolute(configured) || configured.includes('\0') || resolve(configured) === '/') {
    throw new Error('HOME23_ROOT must be an absolute dedicated Home23 directory');
  }
  return resolve(configured);
}

export function getAgentPaths(agentName: string, home23Root = getHome23Root()) {
  return resolveAgentInstancePaths(home23Root, agentName, { requireConfig: false });
}

function buildDefaultIdentityLayers(
  agentName: string,
  identityFiles: string[],
  home23Root: string,
): IdentityLayerConfig[] {
  return [{
    basePath: getAgentPaths(agentName, home23Root).workspaceDir,
    files: identityFiles,
  }];
}

function appendSharedSkillsLayer(agentName: string, config: HomeConfig, home23Root: string): void {
  if (!config.chat) return;

  const routingBasePath = join(home23Root, 'workspace', 'skills');
  const routingFile = 'SKILL_ROUTING.md';
  if (!existsSync(join(routingBasePath, routingFile))) return;

  const currentLayers = config.chat.identityLayers && config.chat.identityLayers.length > 0
    ? [...config.chat.identityLayers]
    : buildDefaultIdentityLayers(agentName, config.chat.identityFiles, home23Root);

  const alreadyPresent = currentLayers.some((layer) =>
    resolve(layer.basePath) === resolve(routingBasePath) && layer.files.includes(routingFile)
  );

  if (!alreadyPresent) {
    currentLayers.push({ basePath: routingBasePath, files: [routingFile] });
  }

  config.chat.identityLayers = currentLayers;
}

export function loadConfig(agentName: string): HomeConfig {
  const home23Root = getHome23Root();
  // Layer 1: Home-level defaults
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));

  // Layer 2: Agent-specific overrides
  const agentConfig = loadYaml(getAgentPaths(agentName, home23Root).configPath);

  // Layer 3: Secrets (API keys, bot tokens — never committed)
  const secrets = loadYaml(join(home23Root, 'config', 'secrets.yaml'));

  // Merge: home ← agent ← secrets (global)
  let config = deepMerge(homeConfig, agentConfig);
  config = deepMerge(config, secrets);

  validateReasoningEffortConfig(config);
  compileProjectWriteRoots(config.files, getAgentPaths(agentName, home23Root).instanceRoot);

  // Layer 4: Per-agent secrets (agents.<name>.telegram.botToken → channels.telegram.botToken)
  const agentSecrets = (secrets as Record<string, unknown>).agents as Record<string, unknown> | undefined;
  const thisAgentSecrets = agentSecrets?.[agentName] as Record<string, unknown> | undefined;
  if (thisAgentSecrets) {
    // Merge agent-specific secrets into channels config
    const channels = (config as Record<string, unknown>).channels as Record<string, unknown> | undefined;

    if (thisAgentSecrets.telegram && channels?.telegram) {
      Object.assign(channels.telegram as Record<string, unknown>, thisAgentSecrets.telegram);
    }

    if (thisAgentSecrets.discord && channels?.discord) {
      Object.assign(channels.discord as Record<string, unknown>, thisAgentSecrets.discord);
    }
  }

  const typedConfig = config as unknown as HomeConfig;
  const derivedLayers = normalizeEmbeddedAgentLayers(typedConfig.chat?.embeddedAgent);
  if (typedConfig.chat && (!typedConfig.chat.identityLayers || typedConfig.chat.identityLayers.length === 0)) {
    typedConfig.chat.identityLayers = derivedLayers ??
      buildDefaultIdentityLayers(agentName, typedConfig.chat.identityFiles, home23Root);
  }
  appendSharedSkillsLayer(agentName, typedConfig, home23Root);

  return typedConfig;
}

/** Home-wide defaults and secrets only; never resolves or reads an agent instance. */
export function loadHomeConfig(): HomeConfig {
  const home23Root = getHome23Root();
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));
  const secrets = loadYaml(join(home23Root, 'config', 'secrets.yaml'));
  const config = deepMerge(homeConfig, secrets) as unknown as HomeConfig;
  validateReasoningEffortConfig(config);
  return config;
}

export function getAgentDir(agentName: string): string {
  return getAgentPaths(agentName).instanceRoot;
}

export function getAgentScratchDir(agentName: string): string {
  return getAgentPaths(agentName).scratchDir;
}

/** Read the selected home's editable aliases at request/turn boundaries. Only
 * these public routing fields reload; in-flight turns keep their resolved pair.
 * No provider credentials or agent identity are reloaded by a catalog read. */
export function createModelAliasReader(homeRoot = getHome23Root(), agentName?: string): () => ModelAliases {
  const homePath = join(homeRoot, 'config', 'home.yaml');
  const agentPath = agentName ? getAgentPaths(agentName, homeRoot).configPath : undefined;
  let revision: string | undefined;
  let aliases: ModelAliases = {};
  function stamp(file: string, optional = false): string {
    try {
      const info = statSync(file);
      return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
  }
  return () => {
    const current = stamp(homePath) + (agentPath ? `|${stamp(agentPath, true)}` : '');
    if (current === revision) return aliases;
    const home = loadYaml(homePath);
    const config = agentPath ? deepMerge(home, loadYaml(agentPath)) : home;
    const candidate = (config.models as { aliases?: ModelAliases } | undefined)?.aliases ?? {};
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Home model aliases must be an object');
    }
    const next: ModelAliases = Object.create(null);
    for (const [alias, value] of Object.entries(candidate)) {
      if (!alias || alias.length > 256 || /[\0\r\n]/u.test(alias)
          || !value || typeof value.provider !== 'string' || !value.provider
          || typeof value.model !== 'string' || !value.model
          || /[\0\r\n]/u.test(value.provider + value.model)) {
        throw new Error('Home model alias must have a valid name, provider and model');
      }
      next[alias] = Object.freeze({ provider: value.provider, model: value.model,
        ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) });
    }
    validateReasoningEffortConfig({ models: { aliases: next } });
    aliases = Object.freeze(next);
    revision = current;
    return aliases;
  };
}
