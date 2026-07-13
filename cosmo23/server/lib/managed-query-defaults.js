'use strict';

function typed(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function chatPairs(models) {
  const pairs = new Set();
  const byModel = new Map();
  for (const row of Array.isArray(models) ? models : []) {
    const provider = nonempty(row?.provider);
    const model = nonempty(row?.id || row?.model);
    if (!provider || !model || (row?.kind && row.kind !== 'chat')) continue;
    pairs.add(`${provider}\0${model}`);
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push({ provider, model });
  }
  return { pairs, byModel };
}

function requireExactPair(source, providerField, modelField, available, label) {
  const provider = nonempty(source?.[providerField]);
  const model = nonempty(source?.[modelField]);
  if (!provider || !model || !available.has(`${provider}\0${model}`)) {
    throw typed('model_catalog_invalid', `${label} exact provider/model pair is unavailable`);
  }
  return { provider, model };
}

function requireUniqueModel(model, byModel, label) {
  const normalized = nonempty(model);
  if (!normalized) throw typed('model_catalog_invalid', `${label} model is unavailable`);
  const candidates = byModel.get(normalized) || [];
  if (candidates.length === 0) {
    throw typed('model_catalog_invalid', `${label} model is unavailable`);
  }
  if (candidates.length !== 1) {
    throw typed('model_ambiguous', `${label} model ${normalized} requires an explicit provider`);
  }
  return candidates[0];
}

function optionalMode(value) {
  return nonempty(value) || 'full';
}

function optionalDepth(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : 0.25;
}

function buildExactQueryDefaults({
  models,
  managed = false,
  managedDefaults = null,
  legacyDefaults = null,
} = {}) {
  const available = chatPairs(models);
  if (available.pairs.size === 0) {
    throw typed('model_catalog_invalid', 'No selectable chat models are available');
  }

  if (managed) {
    if (!isPlainObject(managedDefaults)) {
      throw typed('model_catalog_invalid', 'Managed Query defaults are unavailable');
    }
    const direct = requireExactPair(
      managedDefaults, 'defaultProvider', 'defaultModel', available.pairs, 'Direct Query',
    );
    const sweep = requireExactPair(
      managedDefaults, 'pgsSweepProvider', 'pgsSweepModel', available.pairs, 'PGS sweep',
    );
    const synth = requireExactPair(
      managedDefaults, 'pgsSynthProvider', 'pgsSynthModel', available.pairs, 'PGS synthesis',
    );
    return Object.freeze({
      defaultProvider: direct.provider,
      defaultModel: direct.model,
      pgsSweepProvider: sweep.provider,
      pgsSweepModel: sweep.model,
      pgsSynthProvider: synth.provider,
      pgsSynthModel: synth.model,
      defaultMode: optionalMode(managedDefaults.defaultMode),
      enablePGSByDefault: managedDefaults.enablePGSByDefault === true,
      pgsDepth: optionalDepth(managedDefaults.pgsDepth),
    });
  }

  const direct = requireUniqueModel(legacyDefaults?.queryModel, available.byModel, 'Direct Query');
  const sweep = requireUniqueModel(legacyDefaults?.pgsSweepModel, available.byModel, 'PGS sweep');
  return Object.freeze({
    defaultProvider: direct.provider,
    defaultModel: direct.model,
    pgsSweepProvider: sweep.provider,
    pgsSweepModel: sweep.model,
    pgsSynthProvider: direct.provider,
    pgsSynthModel: direct.model,
    defaultMode: 'full',
    enablePGSByDefault: false,
    pgsDepth: 0.25,
  });
}

module.exports = {
  buildExactQueryDefaults,
};
