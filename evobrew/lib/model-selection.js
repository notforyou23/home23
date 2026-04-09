const CODEX_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark'
];

function parseModelSelection(selection) {
  const normalized = String(selection || '').trim();
  if (!normalized) {
    return {
      selection: '',
      providerId: null,
      modelId: '',
      qualified: false
    };
  }

  const separatorIndex = normalized.indexOf('/');
  if (separatorIndex <= 0) {
    return {
      selection: normalized,
      providerId: null,
      modelId: normalized,
      qualified: false
    };
  }

  return {
    selection: normalized,
    providerId: normalized.slice(0, separatorIndex),
    modelId: normalized.slice(separatorIndex + 1),
    qualified: true
  };
}

function qualifyModelSelection(providerId, modelId) {
  const provider = String(providerId || '').trim();
  const parsed = parseModelSelection(modelId);
  if (parsed.qualified) {
    return parsed.selection;
  }
  if (!provider) {
    return parsed.modelId;
  }
  return `${provider}/${parsed.modelId}`;
}

function getProviderId(selection) {
  return parseModelSelection(selection).providerId;
}

function getModelId(selection) {
  return parseModelSelection(selection).modelId;
}

function matchesProvider(selection, providerId) {
  return getProviderId(selection) === String(providerId || '').trim();
}

function isLegacyCodexModelId(modelId) {
  const normalized = String(modelId || '').trim();
  return (
    normalized === 'gpt-5.4' ||
    normalized === 'gpt-5.4-mini' ||
    normalized === 'gpt-5.4-nano' ||
    normalized.startsWith('gpt-5.2') ||
    normalized === 'gpt-5.3-codex' ||
    normalized === 'gpt-5.3-codex-spark' ||
    normalized.startsWith('gpt-5.3-codex') ||
    normalized.startsWith('gpt-5.4')
  );
}

function isCodexModelSelection(selection) {
  const parsed = parseModelSelection(selection);
  if (parsed.providerId) {
    return parsed.providerId === 'openai-codex';
  }
  return isLegacyCodexModelId(parsed.modelId);
}

module.exports = {
  CODEX_MODEL_IDS,
  parseModelSelection,
  qualifyModelSelection,
  getProviderId,
  getModelId,
  matchesProvider,
  isLegacyCodexModelId,
  isCodexModelSelection
};
