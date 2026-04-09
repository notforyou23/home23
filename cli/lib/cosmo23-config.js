/**
 * COSMO 2.3 Config Pre-Seeder
 *
 * Merges Home23's API keys into COSMO's config.json format.
 * Only touches provider credentials — COSMO's own config system
 * handles everything else (model selection, run settings, etc.).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  return yaml.load(readFileSync(filePath, 'utf8')) || {};
}

export function seedCosmo23Config(home23Root) {
  const secrets = loadYaml(join(home23Root, 'config', 'secrets.yaml'));
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));

  const configDir = join(home23Root, 'cosmo23', '.cosmo23-config');
  const configPath = join(configDir, 'config.json');

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // Read existing config if it exists (preserve user settings)
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      config = {};
    }
  }

  // Ensure structure exists
  if (!config.providers) config.providers = {};
  if (!config.security) config.security = {};
  if (!config.server) config.server = {};

  // Pre-seed API keys from Home23 secrets
  const openaiKey = secrets.providers?.openai?.apiKey || '';
  const xaiKey = secrets.providers?.xai?.apiKey || '';

  if (openaiKey) {
    config.providers.openai = { ...config.providers.openai, enabled: true, api_key: openaiKey };
  }
  if (xaiKey) {
    config.providers.xai = { ...config.providers.xai, enabled: true, api_key: xaiKey };
  }

  // Ensure encryption key exists (generate once, preserve forever)
  if (!config.security.encryption_key) {
    config.security.encryption_key = randomBytes(32).toString('hex');
  }

  // Set security profile
  config.security.profile = config.security.profile || 'local';

  // Write config
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[cosmo23] Config seeded at ${configPath}`);

  return { configDir, configPath };
}
