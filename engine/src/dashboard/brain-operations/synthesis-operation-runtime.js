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

  // A completed synthesis operation stores a metadata claim; the product
  // (insights, self-understanding, recent activity) is the committed brain
  // state that claim points at. Render it back for a result read — before
  // this, action:"result" handed the operator a receipt with no answer
  // body (the 2026-07-19 jerry session delivered exactly that to jtr).
  function renderCommittedAnswer(state) {
    const lines = [];
    const understanding = state.selfUnderstanding;
    if (understanding && typeof understanding === 'object' && !Array.isArray(understanding)) {
      if (understanding.summary) lines.push(`## Self-understanding\n\n${understanding.summary}`);
      if (Array.isArray(understanding.currentObsessions) && understanding.currentObsessions.length) {
        lines.push(`Current obsessions:\n${understanding.currentObsessions.map((item) => `- ${item}`).join('\n')}`);
      }
      if (understanding.relationship) lines.push(`Relationship: ${understanding.relationship}`);
    }
    const insights = Array.isArray(state.consolidatedInsights) ? state.consolidatedInsights : [];
    if (insights.length) {
      lines.push('## Consolidated insights');
      insights.forEach((insight, index) => {
        const themes = Array.isArray(insight?.themes) && insight.themes.length
          ? ` [${insight.themes.join(', ')}]`
          : '';
        const source = insight?.source ? `\n\nSource: ${insight.source}` : '';
        lines.push(`### ${index + 1}. ${insight?.title || 'Untitled'}${themes}\n\n${insight?.excerpt || ''}${source}`);
      });
    }
    const activity = Array.isArray(state.recentActivity) ? state.recentActivity : [];
    if (activity.length) {
      lines.push(`## Recent activity\n\n${activity.map((item) => `- ${item}`).join('\n')}`);
    }
    return lines.join('\n\n');
  }

  async function readCommittedAnswer(resultEnvelope) {
    if (!resultEnvelope || typeof resultEnvelope !== 'object'
        || typeof resultEnvelope.generationMarker !== 'string') {
      return { answerUnavailableReason: 'operation result carries no generation marker' };
    }
    const state = await readCommittedSynthesisState({ brainDir });
    if (!state) return { answerUnavailableReason: 'no committed synthesis state on disk' };
    if (state.operationId !== resultEnvelope.operationId
        || state.generationMarker !== resultEnvelope.generationMarker) {
      return {
        answerUnavailableReason: `superseded: the committed synthesis is now ${state.generationMarker}`
          + ` (operation ${state.operationId}); this operation's product was overwritten by a newer run`,
      };
    }
    const answer = renderCommittedAnswer(state);
    return answer
      ? { answer }
      : { answerUnavailableReason: 'committed synthesis state contains no renderable content' };
  }

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
    readCommittedAnswer,
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
