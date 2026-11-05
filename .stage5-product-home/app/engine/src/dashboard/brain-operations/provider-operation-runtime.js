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
  queryDefaults = null,
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
  let refreshTail = Promise.resolve();
  const settled = Promise.resolve().then(async () => {
    const migration = queryDefaults
      ? { queryDefaults, migrated: false }
      : await migrateQueryDefaultPairs({
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

  function refresh({
    catalog: nextCatalog,
    providerRegistry: nextProviderRegistry,
    queryDefaults: nextQueryDefaults,
  } = {}) {
    const attempt = refreshTail.then(async () => {
      await settled;
      if (!state.resolver) throw state.error;
      // Build and fully validate the replacement before publishing it. A bad
      // catalog/pair leaves the live resolver byte-for-byte reachable.
      const nextResolver = createOperationModelResolver({
        catalog: nextCatalog,
        providerRegistry: nextProviderRegistry,
        queryDefaults: nextQueryDefaults,
      });
      state.resolver = nextResolver;
      state.queryDefaults = nextQueryDefaults;
      state.error = null;
      state.migrated = false;
      state.status = 'ready';
      return Object.freeze({
        refreshed: true,
        queryDefaults: nextQueryDefaults,
      });
    });
    refreshTail = attempt.catch(() => {});
    return attempt;
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
    refresh,
    resolve,
    settled,
    settingsStore,
  });
}

module.exports = {
  createProviderOperationRuntime,
};
