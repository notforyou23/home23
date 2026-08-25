import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

interface YamlMap {
  [key: string]: unknown;
}

function loadYaml(filePath: string): YamlMap {
  if (!existsSync(filePath)) return {};
  const parsed = yaml.load(readFileSync(filePath, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed as YamlMap : {};
}

export interface HomeAssistantCreds {
  url: string;
  token: string;
}

export function loadHomeAssistantCreds(projectRoot: string): HomeAssistantCreds | null {
  const secrets = loadYaml(join(projectRoot, 'config', 'secrets.yaml'));
  const ha = secrets.homeAssistant as { url?: string; token?: string } | undefined;
  const url = ha?.url?.replace(/\/+$/, '');
  const token = ha?.token;
  if (!url || !token) return null;
  return { url, token };
}

export interface ShortcutBridgeConfig {
  enabled: boolean;
  url: string;
  allowedTargets: string[];
}

export function loadShortcutBridge(projectRoot: string): ShortcutBridgeConfig {
  const allowlist = loadYaml(join(projectRoot, 'configs', 'action-allowlist.yaml'));
  const integrations = (allowlist.integrations ?? {}) as YamlMap;
  const bridge = (integrations.shortcut_bridge ?? {}) as { enabled?: boolean; url?: string };
  const actions = (allowlist.actions ?? {}) as YamlMap;
  const runShortcut = (actions.run_shortcut ?? {}) as { allowed_targets?: unknown };
  const allowedTargets = Array.isArray(runShortcut.allowed_targets)
    ? runShortcut.allowed_targets.map((item) => String(item))
    : [];
  return {
    enabled: Boolean(bridge.enabled),
    url: String(bridge.url ?? '').replace(/\/+$/, ''),
    allowedTargets,
  };
}
