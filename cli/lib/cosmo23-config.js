/**
 * COSMO 2.3 Config Pre-Seeder
 *
 * Merges Home23's API keys into COSMO's config.json format.
 * Only touches provider credentials — COSMO's own config system
 * handles everything else (model selection, run settings, etc.).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import {
  ensureBrainOperationsCapabilityKey,
  updateHome23Secrets,
} from './brain-operations-capability.js';

const require = createRequire(import.meta.url);
const {
  buildHome23ModelAuthority,
  loadHome23ModelAuthority,
} = require('../../engine/src/dashboard/home23-model-catalog.js');

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  return yaml.load(readFileSync(filePath, 'utf8')) || {};
}

function loadJson(filePath) {
  if (!existsSync(filePath)) return {};
  try { return JSON.parse(readFileSync(filePath, 'utf8')) || {}; }
  catch { return {}; }
}

function fsyncDirectorySync(directory) {
  const directoryFd = openSync(directory, 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function interruptedCatalogWrite(point) {
  throw Object.assign(new Error(`injected managed model catalog crash at ${point}`), {
    code: 'model_catalog_write_interrupted',
    retryable: true,
  });
}

function writeManagedModelCatalogSync(filePath, serialized, options = {}) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`,
  );
  let tempFd = null;
  let renamed = false;
  try {
    tempFd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(tempFd, serialized, 'utf8');
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    if (options._testCrashAt === 'before-rename') interruptedCatalogWrite('before-rename');
    renameSync(tempPath, filePath);
    renamed = true;
    if (options._testCrashAt === 'after-rename') interruptedCatalogWrite('after-rename');
    fsyncDirectorySync(directory);
  } finally {
    if (tempFd !== null) closeSync(tempFd);
    if (!renamed) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function getKnownLegacyBrainRoots(home23Root) {
  return [
    resolve(home23Root, '..', '..', 'cosmo-home_2.3', 'runs'),
  ].filter(dir => existsSync(dir));
}

// Compute the brain-root set cosmo23's picker should see. Mirrors the logic in
// cli/lib/evobrew-config.js so both pickers enumerate the same brains: every
// home23 agent instance + any external roots the user has configured (evobrew
// config, standalone cosmo2.3 config, env vars) plus known local legacy COSMO
// roots. cosmo23 scans each root one level deep for state.json.gz, which matches
// `instances/<name>/brain/*`.
function computeBrainRoots(home23Root) {
  home23Root = resolve(home23Root);
  const instancesDir = join(home23Root, 'instances');
  const managed = [];
  if (existsSync(instancesDir)) {
    for (const name of readdirSync(instancesDir).sort()) {
      const agentDir = join(instancesDir, name);
      if (existsSync(join(agentDir, 'config.yaml'))) {
        managed.push(resolve(agentDir));
      }
    }
  }

  const external = [];
  const externalConfigs = [
    join(homedir(), '.evobrew', 'config.json'),
    join(homedir(), '.cosmo2.3', 'config.json'),
  ];
  for (const configPath of externalConfigs) {
    const cfg = loadJson(configPath);
    const dirs = Array.isArray(cfg?.features?.brains?.directories)
      ? cfg.features.brains.directories
      : Array.isArray(cfg?.brains?.directories)
        ? cfg.brains.directories
        : [];
    for (const dir of dirs) {
      const t = String(dir || '').trim();
      if (t) external.push(resolve(t));
    }
  }
  for (const envVar of [process.env.COSMO_BRAIN_DIRS, process.env.BRAIN_DIRS]) {
    if (!envVar) continue;
    for (const part of String(envVar).split(',')) {
      const t = part.trim();
      if (t) external.push(resolve(t));
    }
  }

  const all = [...managed, ...external, ...getKnownLegacyBrainRoots(home23Root)];
  const seen = new Set();
  const unique = [];
  for (const dir of all) {
    if (!dir || dir === home23Root || seen.has(dir)) continue;
    seen.add(dir);
    unique.push(dir);
  }
  return unique;
}

export async function seedCosmo23Config(home23Root, options = {}) {
  await ensureBrainOperationsCapabilityKey(home23Root);
  const secrets = loadYaml(join(home23Root, 'config', 'secrets.yaml'));
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));
  const primaryAgent = typeof homeConfig.home?.primaryAgent === 'string'
    ? homeConfig.home.primaryAgent.trim()
    : '';
  const modelAuthority = primaryAgent
    ? loadHome23ModelAuthority({ home23Root, agent: primaryAgent })
    : buildHome23ModelAuthority({ homeConfig, agentConfig: {} });
  const managedModelCatalog = JSON.parse(JSON.stringify(modelAuthority.executionCatalog));

  const configDir = join(home23Root, 'cosmo23', '.cosmo23-config');
  const configPath = join(configDir, 'config.json');
  const modelCatalogPath = join(configDir, 'model-catalog.json');

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
  if (!config.features) config.features = {};
  config.home23 = {
    ...(config.home23 || {}),
    managed: true,
    queryDefaults: JSON.parse(JSON.stringify(modelAuthority.queryDefaults)),
  };

  // Home23 owns brain discovery. Seed the full root set (every agent instance +
  // any external roots the user has configured via ~/.evobrew or ~/.cosmo2.3 or
  // env vars) so cosmo23's picker sees every brain evobrew sees. Local cosmo23
  // runs/ is scanned automatically by the server and doesn't need to be listed.
  config.features.brains = {
    enabled: true,
    directories: computeBrainRoots(home23Root),
  };

  // Pre-seed API keys from Home23 secrets (plaintext — config dir is gitignored).
  // The cosmo23 server's launch path prefers process.env under Home23 (PM2
  // injection), so these stored values mostly serve the Web UI setup checker.
  // Still seeded so `/api/setup/status` reports `configured=true`.
  const openaiKey = secrets.providers?.openai?.apiKey || '';
  const xaiKey = secrets.providers?.xai?.apiKey || '';
  const ollamaCloudKey = secrets.providers?.['ollama-cloud']?.apiKey || '';
  const minimaxKey = secrets.providers?.minimax?.apiKey || '';
  const anthropicKey = secrets.providers?.anthropic?.apiKey || '';
  const codexKey = secrets.providers?.['openai-codex']?.apiKey || '';

  if (openaiKey) {
    config.providers.openai = { ...config.providers.openai, enabled: true, api_key: openaiKey };
  }
  if (xaiKey) {
    config.providers.xai = { ...config.providers.xai, enabled: true, api_key: xaiKey };
  }
  if (ollamaCloudKey) {
    config.providers['ollama-cloud'] = { ...config.providers['ollama-cloud'], enabled: true, api_key: ollamaCloudKey };
  }
  if (minimaxKey) {
    config.providers.minimax = {
      ...config.providers.minimax,
      enabled: true,
      api_key: minimaxKey,
      base_url: homeConfig.providers?.minimax?.baseUrl || 'https://api.minimax.io/anthropic'
    };
  }
  if (anthropicKey) {
    // COSMO anthropic is OAuth-only — we still record enabled=true so UI shows provider as available
    config.providers.anthropic = { ...config.providers.anthropic, enabled: true };
  }
  if (codexKey) {
    // COSMO openai-codex is OAuth-only. Home23 injects the JWT through PM2;
    // the stored provider flag keeps managed setup/provider status coherent.
    config.providers['openai-codex'] = { ...config.providers['openai-codex'], enabled: true, oauth: true };
  }

  // Ensure ollama (local) and ollama-cloud base URLs come from home.yaml
  const ollamaLocalUrl = homeConfig.providers?.['ollama-local']?.baseUrl || 'http://localhost:11434';
  config.providers.ollama = { ...config.providers.ollama, enabled: true, base_url: ollamaLocalUrl, auto_detect: true };

  // Encryption key: secrets.yaml is the single source of truth.
  // Three cases: (1) secrets has it → use it, (2) config has it but secrets doesn't
  // → adopt it into secrets, (3) neither → generate and persist to both.
  const secretsEncKey = secrets.cosmo23?.encryptionKey;
  if (secretsEncKey) {
    // Case 1: secrets.yaml has the key — propagate to config.json
    config.security.encryption_key = secretsEncKey;
  } else {
    // Cases 2 and 3: adopt existing config key or generate new one
    const preferredKey = config.security.encryption_key || randomBytes(32).toString('hex');
    const encryptionUpdate = await updateHome23Secrets(home23Root, (currentSecrets) => {
      if (!currentSecrets.cosmo23) currentSecrets.cosmo23 = {};
      if (currentSecrets.cosmo23.encryptionKey) {
        return { changed: false, value: currentSecrets.cosmo23.encryptionKey };
      }
      currentSecrets.cosmo23.encryptionKey = preferredKey;
      return { changed: true, value: preferredKey };
    });
    const key = encryptionUpdate.value;
    config.security.encryption_key = key;
    if (encryptionUpdate.changed) {
      console.log('[cosmo23] Encryption key synced to secrets.yaml');
    }
  }

  // Set security profile
  config.security.profile = config.security.profile || 'local';

  // Write config
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeManagedModelCatalogSync(
    modelCatalogPath,
    `${JSON.stringify(managedModelCatalog, null, 2)}\n`,
    { _testCrashAt: options._testModelCatalogCrashAt },
  );
  console.log(`[cosmo23] Config seeded at ${configPath}`);
  console.log(`[cosmo23] Managed model catalog synced at ${modelCatalogPath}`);

  return { configDir, configPath, modelCatalogPath };
}
