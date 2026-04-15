/**
 * Home23 — Configuration Loader
 *
 * Three-layer merge: config/home.yaml ← instances/{agent}/config.yaml ← config/secrets.yaml
 * Deep merge — agent values override home defaults, secrets overlay on top.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import type { HomeConfig, IdentityLayerConfig, EmbeddedAgentConfig } from './types.js';

const HOME23_ROOT = resolve(import.meta.dirname, '..');

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

function buildDefaultIdentityLayers(agentName: string, identityFiles: string[]): IdentityLayerConfig[] {
  return [{
    basePath: join(HOME23_ROOT, 'instances', agentName, 'workspace'),
    files: identityFiles,
  }];
}

function appendSharedSkillsLayer(agentName: string, config: HomeConfig): void {
  if (!config.chat) return;

  const routingBasePath = join(HOME23_ROOT, 'workspace', 'skills');
  const routingFile = 'SKILL_ROUTING.md';
  if (!existsSync(join(routingBasePath, routingFile))) return;

  const currentLayers = config.chat.identityLayers && config.chat.identityLayers.length > 0
    ? [...config.chat.identityLayers]
    : buildDefaultIdentityLayers(agentName, config.chat.identityFiles);

  const alreadyPresent = currentLayers.some((layer) =>
    resolve(layer.basePath) === resolve(routingBasePath) && layer.files.includes(routingFile)
  );

  if (!alreadyPresent) {
    currentLayers.push({ basePath: routingBasePath, files: [routingFile] });
  }

  config.chat.identityLayers = currentLayers;
}

export function loadConfig(agentName: string): HomeConfig {
  // Layer 1: Home-level defaults
  const homeConfig = loadYaml(join(HOME23_ROOT, 'config', 'home.yaml'));

  // Layer 2: Agent-specific overrides
  const agentConfig = loadYaml(join(HOME23_ROOT, 'instances', agentName, 'config.yaml'));

  // Layer 3: Secrets (API keys, bot tokens — never committed)
  const secrets = loadYaml(join(HOME23_ROOT, 'config', 'secrets.yaml'));

  // Merge: home ← agent ← secrets (global)
  let config = deepMerge(homeConfig, agentConfig);
  config = deepMerge(config, secrets);

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
    typedConfig.chat.identityLayers = derivedLayers ?? buildDefaultIdentityLayers(agentName, typedConfig.chat.identityFiles);
  }
  appendSharedSkillsLayer(agentName, typedConfig);

  return typedConfig;
}

export function getHome23Root(): string {
  return HOME23_ROOT;
}

export function getAgentDir(agentName: string): string {
  return join(HOME23_ROOT, 'instances', agentName);
}
