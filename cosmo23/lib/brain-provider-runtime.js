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
  const home = readYamlRegularFile(path.join(home23Root, 'config', 'home.yaml'), {
    yamlImpl,
  });
  const secrets = readYamlRegularFile(path.join(home23Root, 'config', 'secrets.yaml'), {
    optional: true,
    yamlImpl,
  });
  return Object.freeze({
    home,
    providerConfig: mergeProviderConfiguration(home, secrets),
  });
}

function defaultCodexCredentialsProvider() {
  const { getCodexCredentials } = require('../engine/src/services/codex-oauth-engine');
  return (options = {}) => getCodexCredentials(options);
}

function createHome23BrainProviderRuntime({
  home23Root,
  catalog,
  fetchImpl = globalThis.fetch,
  logger = console,
  yamlImpl = yaml,
  credentialsProviders = {},
  pairFactories = {},
} = {}) {
  const loaded = loadHome23BrainProviderConfig({ home23Root, yamlImpl });
  const exactCredentialsProviders = {
    'openai-codex': defaultCodexCredentialsProvider(),
    ...credentialsProviders,
  };
  const providerRegistry = createBrainProviderClientRegistry({
    catalog,
    providerConfig: loaded.providerConfig,
    credentialsProviders: exactCredentialsProviders,
    fetchImpl,
    logger,
    pairFactories,
  });
  return Object.freeze({
    home: loaded.home,
    providerConfig: loaded.providerConfig,
    providerRegistry,
  });
}

module.exports = {
  createHome23BrainProviderRuntime,
  loadHome23BrainProviderConfig,
  mergeProviderConfiguration,
  readYamlRegularFile,
};
