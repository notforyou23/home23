'use strict';

const path = require('node:path');
const yaml = require('js-yaml');
const { createYamlSettingsStore } = require('../yaml-settings-store.js');
const {
  createOperationModelResolver,
  migrateQueryDefaultPairs,
} = require('./operation-model-resolver.js');

function runtimeError(error) {
  if (error?.code) return error;
  return Object.assign(new Error('Brain provider operation runtime is unavailable'), {
    code: 'provider_unavailable',
    retryable: true,
    cause: error,
  });
}

function createProviderOperationRuntime({
  home23Root,
  catalog,
  providerRegistry,
  yamlImpl = yaml,
  logger = console,
} = {}) {
  const state = {
    status: 'starting',
    error: null,
    resolver: null,
    queryDefaults: null,
    migrated: false,
  };
  const settingsStore = createYamlSettingsStore({
    home23Root,
    filePath: path.join(home23Root, 'config', 'home.yaml'),
    yaml: yamlImpl,
    logger,
  });
  const settled = Promise.resolve().then(async () => {
    const migration = await migrateQueryDefaultPairs({
      settingsStore,
      catalog,
      providerRegistry,
    });
    state.resolver = createOperationModelResolver({
      catalog,
      providerRegistry,
      queryDefaults: migration.queryDefaults,
    });
    state.queryDefaults = migration.queryDefaults;
    state.migrated = migration.migrated;
    state.status = 'ready';
  }).catch((error) => {
    state.error = runtimeError(error);
    state.status = 'unavailable';
    logger.error?.('[brain-operations] provider operation runtime unavailable', {
      code: state.error.code,
      retryable: state.error.retryable === true,
    });
  });

  async function resolve(input) {
    await settled;
    if (!state.resolver) throw state.error;
    return state.resolver(input);
  }

  function getReadiness() {
    return Object.freeze({
      ready: state.status === 'ready',
      status: state.status,
      code: state.error?.code || null,
      retryable: state.error?.retryable === true,
      migrated: state.status === 'ready' ? state.migrated : false,
    });
  }

  return Object.freeze({
    getReadiness,
    resolve,
    settled,
    settingsStore,
  });
}

module.exports = {
  createProviderOperationRuntime,
};
