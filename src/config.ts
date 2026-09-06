/**
 * Home23 — Configuration Loader
 *
 * Three-layer merge: config/home.yaml ← instances/{agent}/config.yaml ← config/secrets.yaml
 * Deep merge — agent values override home defaults, secrets overlay on top.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, join } from 'node:path';
import yaml from 'js-yaml';
import type { HomeConfig, IdentityLayerConfig, EmbeddedAgentConfig } from './types.js';
import { validateReasoningEffortConfig } from './agent/reasoning-effort.js';

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
