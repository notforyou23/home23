'use strict';

const {
  SynthesisAgent,
  readCommittedSynthesisState,
} = require('../../synthesis/synthesis-agent.js');
const {
  createSynthesisProviderAdapter,
  resolveSynthesisConfig,
} = require('../../synthesis/provider-registry.js');
const { createSynthesisWorker } = require('./synthesis-worker.js');

function typed(code, message, retryable = false, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    retryable,
  });
}

async function persistSelection(settingsStore, resolved, { maxAttempts = 4 } = {}) {
  if (!resolved.needsPersistence) return false;
  if (!settingsStore || typeof settingsStore.read !== 'function'
      || typeof settingsStore.update !== 'function'
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw typed('settings_unavailable', 'Synthesis settings migration is unavailable', true);
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await settingsStore.read();
    const configured = current.data?.synthesis;
    if (configured?.provider === resolved.selection.provider
        && configured?.model === resolved.selection.model
        && Number(configured?.intervalHours) === resolved.intervalHours) return false;
    try {
      await settingsStore.update({
        expectedVersion: current.version,
        mutate(data) {
          data.synthesis = {
            ...(data.synthesis && !Array.isArray(data.synthesis)
              && typeof data.synthesis === 'object' ? data.synthesis : {}),
            provider: resolved.selection.provider,
            model: resolved.selection.model,
            intervalHours: resolved.intervalHours,
          };
          return data;
        },
      });
      return true;
    } catch (error) {
      if (error?.code !== 'settings_changed' || attempt + 1 >= maxAttempts) throw error;
    }
  }
  throw typed('settings_changed', 'Synthesis settings changed repeatedly', true);
}

function createDashboardSynthesisOperationRuntime({
  brainDir,
  workspacePath,
  homeConfig,
  catalog,
  providerRegistry,
  settingsStore,
  startOperation,
  logger = console,
  clock,
  timers,
  SynthesisAgentClass = SynthesisAgent,
} = {}) {
  if (typeof startOperation !== 'function') {
    throw typed('synthesis_configuration_invalid', 'Durable synthesis start callback required');
  }
  const resolved = resolveSynthesisConfig({
    homeConfig,
    modelCatalog: catalog,
    providerRegistry,
  });
  const providerAdapter = createSynthesisProviderAdapter(resolved);
  const state = { status: 'starting', error: null, migrated: false };
  const agent = new SynthesisAgentClass({
    brainDir,
    workspacePath,
    providerAdapter,
    intervalHours: resolved.intervalHours,
    logger,
    clock,
    timers,
    startSynthesisOperation: ({ trigger }) => startOperation({
      trigger,
      selection: resolved.selection,
    }),
  });
  const executor = createSynthesisWorker({ agent, selection: resolved.selection });
  const settled = persistSelection(settingsStore, resolved)
    .then((migrated) => {
      state.migrated = migrated;
      state.status = 'ready';
    })
    .catch((error) => {
      state.error = error?.code ? error : typed(
        'settings_unavailable', 'Synthesis settings migration failed', true, error,
      );
      state.status = 'unavailable';
      logger.error?.('[synthesis] settings migration unavailable', {
        code: state.error.code,
        retryable: state.error.retryable === true,
      });
    });

  async function resolveParameters({ operationType, requestParameters } = {}) {
    await settled;
    if (state.error) throw state.error;
    if (operationType !== 'synthesis'
        || !requestParameters || Array.isArray(requestParameters)
        || typeof requestParameters !== 'object') {
      throw typed('invalid_request', 'Invalid synthesis operation request');
    }
    return Object.freeze({
      ...structuredClone(requestParameters),
      provider: resolved.selection.provider,
      model: resolved.selection.model,
    });
  }

  return Object.freeze({
    agent,
    executor,
    selection: resolved.selection,
    settled,
    resolveParameters,
    readState: (options = {}) => readCommittedSynthesisState({ brainDir, ...options }),
    getReadiness: () => Object.freeze({
      ready: state.status === 'ready',
      status: state.status,
      code: state.error?.code || null,
      retryable: state.error?.retryable === true,
      migrated: state.status === 'ready' ? state.migrated : false,
    }),
  });
}

module.exports = {
  createDashboardSynthesisOperationRuntime,
  persistSynthesisSelection: persistSelection,
};
