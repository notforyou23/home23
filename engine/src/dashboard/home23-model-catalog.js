'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  BUILTIN_EXECUTION_DEFAULTS,
  BUILTIN_MODEL_CATALOG,
} = require('../../../cosmo23/server/config/model-catalog.js');

const SAFE_AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PROVIDER_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCE = 'home23-config';

function catalogError(message, cause = null) {
  const error = Object.assign(new Error(message), {
    code: 'model_catalog_invalid',
    retryable: false,
  });
  if (cause) error.cause = cause;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalObject(value, label) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw catalogError(`${label} must be an object`);
  return value;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerLabel(provider, configured) {
  return nonempty(configured.label)
    || nonempty(BUILTIN_MODEL_CATALOG.providers?.[provider]?.label)
    || provider;
}

function makeExecutionRow(provider, model, executionDefaults) {
  return {
    id: model,
    label: model,
    kind: 'chat',
    provider,
    source: SOURCE,
    ...deepClone(executionDefaults),
  };
}

function makeDisplayRow(provider, label, model, executionDefaults) {
  return {
    id: model,
    model,
    name: model,
    label: model,
    provider,
    providerLabel: label,
    kind: 'chat',
    source: SOURCE,
    ...deepClone(executionDefaults),
  };
}

function exactPair(provider, model) {
  const normalizedProvider = nonempty(provider);
  const normalizedModel = nonempty(model);
  return normalizedProvider && normalizedModel
    ? { provider: normalizedProvider, model: normalizedModel }
    : null;
}

function buildHome23ModelAuthority({ homeConfig, agentConfig = {} } = {}) {
  const home = optionalObject(homeConfig, 'Home23 config');
  const agent = optionalObject(agentConfig, 'Agent config');
  const configuredProviders = optionalObject(home.providers, 'Home23 providers');
  const providers = {};
  const models = [];
  const configuredPairs = new Set();

  for (const provider of Object.keys(BUILTIN_EXECUTION_DEFAULTS)) {
    const configured = optionalObject(configuredProviders[provider], `Provider ${provider}`);
    const defaults = deepClone(BUILTIN_EXECUTION_DEFAULTS[provider]);
    providers[provider] = {
      label: providerLabel(provider, configured),
      executionDefaults: defaults,
      models: [],
    };
  }

  for (const [provider, rawConfig] of Object.entries(configuredProviders)) {
    if (!SAFE_PROVIDER.test(provider) || RESERVED_PROVIDER_IDS.has(provider)) {
      throw catalogError(`Invalid Home23 provider ID: ${provider}`);
    }
    const configured = optionalObject(rawConfig, `Provider ${provider}`);
    if (configured.defaultModels === undefined || configured.defaultModels === null) continue;
    if (!Array.isArray(configured.defaultModels)) {
      throw catalogError(`Provider ${provider} defaultModels must be an array`);
    }
    const declaredModels = configured.defaultModels.map(nonempty).filter(Boolean);
    if (declaredModels.length === 0) continue;
    const executionDefaults = BUILTIN_EXECUTION_DEFAULTS[provider];
    if (!executionDefaults) {
      throw catalogError(`Provider ${provider} has no reviewed execution capabilities`);
    }
    const label = providerLabel(provider, configured);
    const seen = new Set();
    for (const model of declaredModels) {
      if (seen.has(model)) {
        throw catalogError(`Duplicate Home23 model pair ${provider}/${model}`);
      }
      seen.add(model);
      const key = `${provider}\0${model}`;
      configuredPairs.add(key);
      const executionRow = makeExecutionRow(provider, model, executionDefaults);
      providers[provider].models.push(executionRow);
      models.push(makeDisplayRow(provider, label, model, executionDefaults));
    }
  }

  const embeddingDefaults = deepClone(BUILTIN_MODEL_CATALOG.defaults.embeddings);
  const homeEmbeddings = optionalObject(home.embeddings, 'Home23 embeddings config');
  if (homeEmbeddings.providers !== undefined && !Array.isArray(homeEmbeddings.providers)) {
    throw catalogError('Home23 embeddings providers must be an array');
  }
  const configuredEmbedding = (homeEmbeddings.providers || []).find((entry) => (
    isPlainObject(entry)
      && nonempty(entry.provider) === embeddingDefaults.provider
      && nonempty(entry.model) === embeddingDefaults.model
  ));
  if (configuredEmbedding) {
    if (!Number.isSafeInteger(configuredEmbedding.dimensions)
        || configuredEmbedding.dimensions <= 0) {
      throw catalogError('Home23 canonical embedding dimensions must be a positive safe integer');
    }
    embeddingDefaults.dimensions = configuredEmbedding.dimensions;
  }
  const embeddingProvider = providers[embeddingDefaults.provider];
  const canonicalEmbedding = BUILTIN_MODEL_CATALOG.providers?.[embeddingDefaults.provider]?.models
    ?.find((row) => row.kind === 'embedding' && row.id === embeddingDefaults.model);
  if (!embeddingProvider || !canonicalEmbedding) {
    throw catalogError('COSMO canonical embedding defaults are unavailable');
  }
  if (embeddingProvider.models.some((row) => row.id === canonicalEmbedding.id)) {
    throw catalogError(
      `Home23 chat model conflicts with canonical embedding ${embeddingDefaults.provider}/${canonicalEmbedding.id}`,
    );
  }
  embeddingProvider.models.push(deepClone(canonicalEmbedding));

  const homeChat = optionalObject(home.chat, 'Home23 chat config');
  const agentChat = optionalObject(agent.chat, 'Agent chat config');
  const chatPair = exactPair(
    nonempty(agentChat.defaultProvider) || nonempty(agentChat.provider)
      || nonempty(homeChat.defaultProvider) || nonempty(homeChat.provider),
    nonempty(agentChat.defaultModel) || nonempty(agentChat.model)
      || nonempty(homeChat.defaultModel) || nonempty(homeChat.model),
  );
  if (!chatPair || !configuredPairs.has(`${chatPair.provider}\0${chatPair.model}`)) {
    const identity = chatPair ? `${chatPair.provider}/${chatPair.model}` : 'missing';
    throw catalogError(`Current Chat pair is not configured in Home23 defaultModels: ${identity}`);
  }

  const query = agent.query === undefined || agent.query === null
    ? optionalObject(home.query, 'Home23 query config')
    : optionalObject(agent.query, 'Agent query config');
  function resolveRole(provider, model) {
    const preferred = exactPair(provider, model);
    return preferred && configuredPairs.has(`${preferred.provider}\0${preferred.model}`)
      ? preferred
      : { ...chatPair };
  }
  const direct = resolveRole(
    nonempty(query.defaultProvider) || nonempty(query.provider),
    query.defaultModel,
  );
  const pgsSweep = resolveRole(query.pgsSweepProvider, query.pgsSweepModel);
  const pgsSynth = resolveRole(query.pgsSynthProvider, query.pgsSynthModel);
  const queryDefaults = {
    defaultProvider: direct.provider,
    defaultModel: direct.model,
    pgsSweepProvider: pgsSweep.provider,
    pgsSweepModel: pgsSweep.model,
    pgsSynthProvider: pgsSynth.provider,
    pgsSynthModel: pgsSynth.model,
    defaultMode: nonempty(query.defaultMode) || 'full',
    enablePGSByDefault: query.enablePGSByDefault === true,
    pgsDepth: typeof query.pgsDepth === 'number' && Number.isFinite(query.pgsDepth)
      ? query.pgsDepth
      : 0.25,
  };
  const executionCatalog = {
    version: 1,
    providers,
    defaults: {
      queryModel: direct.model,
      pgsSweepModel: pgsSweep.model,
      launch: {
        primary: direct.model,
        fast: direct.model,
        strategic: direct.model,
      },
      embeddings: embeddingDefaults,
    },
  };

  return deepFreeze({ models, queryDefaults, executionCatalog });
}

function readYamlRegularFile(filePath, yamlImpl) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw catalogError(`Home23 model config path is unsafe: ${filePath}`);
    }
    const parsed = yamlImpl.load(fs.readFileSync(filePath, 'utf8')) || {};
    if (!isPlainObject(parsed)) {
      throw catalogError(`Home23 model config root must be an object: ${filePath}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'model_catalog_invalid') throw error;
    throw catalogError(`Unable to read Home23 model config: ${filePath}`, error);
  }
}

function loadHome23ModelAuthority({ home23Root, agent, yamlImpl = yaml } = {}) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw catalogError('Absolute Home23 root required');
  }
  const selectedAgent = nonempty(agent);
  if (agent !== undefined && agent !== null && typeof agent !== 'string') {
    throw catalogError('Valid Home23 agent required');
  }
  if (selectedAgent && !SAFE_AGENT.test(selectedAgent)) {
    throw catalogError('Valid Home23 agent required');
  }
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native(home23Root);
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw catalogError('Home23 root is unavailable', error);
  }
  const homeConfig = readYamlRegularFile(
    path.join(canonicalRoot, 'config', 'home.yaml'),
    yamlImpl,
  );
  const agentConfig = selectedAgent
    ? readYamlRegularFile(
      path.join(canonicalRoot, 'instances', selectedAgent, 'config.yaml'),
      yamlImpl,
    )
    : {};
  return buildHome23ModelAuthority({ homeConfig, agentConfig });
}

module.exports = {
  buildHome23ModelAuthority,
  loadHome23ModelAuthority,
};
