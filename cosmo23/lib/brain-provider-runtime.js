'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { createBrainProviderClientRegistry } = require('./brain-provider-client-registry');

function runtimeError(code, message, cause) {
  return Object.assign(new Error(message), { code, retryable: true, cause });
}

function readYamlRegularFile(filePath, { optional = false, yamlImpl = yaml } = {}) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    throw runtimeError('provider_configuration_invalid', `Provider settings unavailable: ${filePath}`, error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw runtimeError('provider_configuration_invalid', `Provider settings path is unsafe: ${filePath}`);
  }
  let data;
  try { data = yamlImpl.load(fs.readFileSync(filePath, 'utf8')) || {}; } catch (error) {
    throw runtimeError('provider_configuration_invalid', `Provider settings are invalid: ${filePath}`, error);
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw runtimeError('provider_configuration_invalid', `Provider settings root is invalid: ${filePath}`);
  }
  return data;
}

function plainProviders(value, source) {
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw runtimeError('provider_configuration_invalid', `${source} providers must be an object`);
  }
  return value;
}

function mergeProviderConfiguration(home, secrets) {
  const configured = plainProviders(home?.providers, 'Home23');
  const secretProviders = plainProviders(secrets?.providers, 'Home23 secrets');
  const result = {};
  const providerIds = new Set([...Object.keys(configured), ...Object.keys(secretProviders)]);
  for (const provider of [...providerIds].sort()) {
    const publicConfig = configured[provider] ?? {};
    const privateConfig = secretProviders[provider] ?? {};
    if (!publicConfig || Array.isArray(publicConfig) || typeof publicConfig !== 'object'
        || !privateConfig || Array.isArray(privateConfig) || typeof privateConfig !== 'object') {
      throw runtimeError('provider_configuration_invalid', `Provider config is invalid: ${provider}`);
    }
    result[provider] = { ...publicConfig, ...privateConfig };
  }
  if (!result.anthropic) result.anthropic = {};
  const anthropicCredential = result.anthropic.authToken
    || result.anthropic.auth_token
    || result.anthropic.apiKey
    || result.anthropic.api_key;
  const anthropicOauthManaged = result.anthropic.oauthManaged === true
    || (typeof anthropicCredential === 'string' && anthropicCredential.startsWith('sk-ant-oat'));
  if (anthropicOauthManaged && anthropicCredential) {
    result.anthropic.authToken = anthropicCredential;
    delete result.anthropic.apiKey;
    delete result.anthropic.api_key;
  }
  if (!result.anthropic.apiKey && !result.anthropic.api_key
      && !result.anthropic.authToken && !result.anthropic.auth_token) {
    result.anthropic.useOAuthService = true;
  }
  return result;
}

function loadHome23BrainProviderConfig({ home23Root, yamlImpl = yaml } = {}) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw runtimeError('provider_configuration_invalid', 'Absolute Home23 root required');
  }
  let canonicalHome;
  let configDir;
  try {
    canonicalHome = fs.realpathSync(home23Root);
    configDir = path.join(canonicalHome, 'config');
    const configStat = fs.lstatSync(configDir);
    if (configStat.isSymbolicLink() || !configStat.isDirectory()) throw new Error('unsafe config');
  } catch (error) {
    throw runtimeError('provider_configuration_invalid', 'Home23 config directory is unsafe', error);
  }
  const home = readYamlRegularFile(path.join(configDir, 'home.yaml'), {
    yamlImpl,
  });
  const secrets = readYamlRegularFile(path.join(configDir, 'secrets.yaml'), {
    optional: true,
    yamlImpl,
  });
  return Object.freeze({
    home,
    providerConfig: mergeProviderConfiguration(home, secrets),
  });
}

function defaultCodexCredentialsProvider() {
  return (options = {}) => {
    const { getCodexCredentials } = require('../engine/src/services/codex-oauth-engine');
    return getCodexCredentials(options);
  };
}

/**
 * Rotation awareness (2026-08-11): clients used to bind credentials once, at
 * registry construction — the one consumer of secrets.yaml that bypassed
 * read-at-use. Since a token rotation now restarts NOTHING (the poller's
 * rotationRestartTargets is []), a frozen registry would serve a revoked
 * sk-ant-oat until an unrelated restart. The registry facade below stats the
 * config files (throttled) and rebuilds the inner registry when they change;
 * a failed rebuild keeps serving the previous registry and retries.
 */
const CREDENTIAL_CHECK_MS = 15_000;

function credentialFingerprint(configDir) {
  const parts = [];
  for (const name of ['secrets.yaml', 'home.yaml']) {
    try {
      const stat = fs.statSync(path.join(configDir, name));
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${name}:absent`);
    }
  }
  return parts.join('|');
}

function createHome23BrainProviderRuntime({
  home23Root,
  catalog,
  fetchImpl = globalThis.fetch,
  logger = console,
  yamlImpl = yaml,
  credentialsProviders = {},
  pairFactories = {},
  credentialCheckMs = CREDENTIAL_CHECK_MS,
} = {}) {
  const exactCredentialsProviders = {
    'openai-codex': defaultCodexCredentialsProvider(),
    ...credentialsProviders,
  };
  const build = () => {
    const loaded = loadHome23BrainProviderConfig({ home23Root, yamlImpl });
    const registry = createBrainProviderClientRegistry({
      catalog,
      providerConfig: loaded.providerConfig,
      credentialsProviders: exactCredentialsProviders,
      fetchImpl,
      logger,
      pairFactories,
    });
    return { loaded, registry };
  };
  let current = build();
  const configDir = path.join(fs.realpathSync(home23Root), 'config');
  let fingerprint = credentialFingerprint(configDir);
  let lastCheck = Date.now();
  const ensureFresh = () => {
    const now = Date.now();
    if (now - lastCheck < credentialCheckMs) return;
    lastCheck = now;
    const next = credentialFingerprint(configDir);
    if (next === fingerprint) return;
    try {
      current = build();
      fingerprint = next; // adopted only on success — a torn write keeps the old registry serving
      logger?.info?.('[brain-providers] provider credentials changed on disk — registry rebuilt');
    } catch (error) {
      logger?.warn?.(`[brain-providers] credential change detected but rebuild failed (${error?.message}); serving previous registry`);
    }
  };
  const providerRegistry = Object.freeze({
    get: (provider, model) => { ensureFresh(); return current.registry.get(provider, model); },
    getExact: (provider, model) => { ensureFresh(); return current.registry.getExact(provider, model); },
    has: (provider, model) => { ensureFresh(); return current.registry.has(provider, model); },
    availability: (provider, model) => { ensureFresh(); return current.registry.availability(provider, model); },
    assertPairAvailable: (provider, model) => { ensureFresh(); return current.registry.assertPairAvailable(provider, model); },
  });
  return Object.freeze({
    get home() { return current.loaded.home; },
    get providerConfig() { return current.loaded.providerConfig; },
    providerRegistry,
  });
}

module.exports = {
  createHome23BrainProviderRuntime,
  loadHome23BrainProviderConfig,
  mergeProviderConfiguration,
  readYamlRegularFile,
};
