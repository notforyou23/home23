const GUIDED_EFFECTIVE_MODE = 'guided-exclusive';
const AUTONOMOUS_EFFECTIVE_MODE = 'autonomous';

function isGuidedExplorationMode(explorationMode) {
  return String(explorationMode || '').trim().toLowerCase() === 'guided';
}

function normalizeExecutionMode(explorationMode, requestedMode) {
  const normalizedExploration = String(explorationMode || 'guided').trim().toLowerCase() || 'guided';
  const normalizedRequested = String(requestedMode || '').trim().toLowerCase() || null;

  if (isGuidedExplorationMode(normalizedExploration)) {
    return {
      requestedMode: normalizedRequested || 'strict',
      persistedMode: 'strict',
      effectiveMode: GUIDED_EFFECTIVE_MODE,
      label: 'Guided Exclusive',
      deprecatedInput: Boolean(normalizedRequested && !['strict', GUIDED_EFFECTIVE_MODE].includes(normalizedRequested))
    };
  }

  return {
    requestedMode: normalizedRequested || AUTONOMOUS_EFFECTIVE_MODE,
    persistedMode: normalizedRequested && normalizedRequested !== GUIDED_EFFECTIVE_MODE
      ? normalizedRequested
      : 'mixed',
    effectiveMode: AUTONOMOUS_EFFECTIVE_MODE,
    label: 'Autonomous',
    deprecatedInput: false
  };
}

function isGuidedExclusiveMode(mode) {
  return String(mode || '').trim().toLowerCase() === GUIDED_EFFECTIVE_MODE;
}

module.exports = {
  GUIDED_EFFECTIVE_MODE,
  AUTONOMOUS_EFFECTIVE_MODE,
  isGuidedExplorationMode,
  normalizeExecutionMode,
  isGuidedExclusiveMode
};
