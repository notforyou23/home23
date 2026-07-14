'use strict';

const { queryModePolicy } = require('./query-mode-policy');

const MODE_STRUCTURE = Object.freeze({
  full: Object.freeze([
    /\bfindings?\b/i,
    /\bevidence\b/i,
    /\bimplications?\b/i,
    /\b(?:gaps?|limitations?)\b/i,
  ]),
  expert: Object.freeze([
    /\bevidence\b/i,
    /\binference\b/i,
    /\bcontradictions?\b/i,
    /\bconfidence\b/i,
    /\b(?:unresolved|open) questions?\b|\bgaps?\b/i,
  ]),
  dive: Object.freeze([
    /\bthemes?\b/i,
    /\b(?:non-obvious )?connections?\b/i,
    /\bconvergence\b/i,
    /\bcontradictions?\b/i,
    /\bactionable implications?\b/i,
  ]),
});

const PROJECTION_DISCLOSURE = /\b(?:projection|retained (?:prompt )?subset|prompt budget|coverage limit|limited evidence|not the entire brain|PGS)\b/i;

function materialProjectionLimit(projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false;
  return projection.promptReduced === true
    || projection.byteBudgetTruncated === true
    || (Number.isSafeInteger(projection.droppedForPromptBudget)
      && projection.droppedForPromptBudget > 0)
    || (Number.isSafeInteger(projection.droppedForByteBudget)
      && projection.droppedForByteBudget > 0);
}

function hasRequiredStructure(mode, answer, projection) {
  const markers = MODE_STRUCTURE[mode] || [];
  if (!markers.every(marker => marker.test(answer))) return false;
  return !materialProjectionLimit(projection) || PROJECTION_DISCLOSURE.test(answer);
}

function assessQueryAnswer({ mode, answer, healthyEvidence, projection } = {}) {
  const policy = queryModePolicy(mode);
  if (typeof answer !== 'string') {
    const error = new Error('Query answer must be a string');
    error.code = 'invalid_request';
    error.retryable = false;
    throw error;
  }
  if (policy.expansionEnabled === false) {
    return Object.freeze({
      quality: 'not-required',
      shouldExpand: false,
      reasons: Object.freeze([]),
    });
  }

  const reasons = [];
  if (healthyEvidence !== true) reasons.push('evidence_constrained');
  if (answer.trim().length < policy.minimumAnswerCharacters) {
    reasons.push('answer_too_short');
  }
  if (!hasRequiredStructure(mode, answer, projection)) {
    reasons.push('missing_required_structure');
  }
  const quality = reasons.length === 0 ? 'substantial' : 'constrained';
  return Object.freeze({
    quality,
    shouldExpand: healthyEvidence === true && quality === 'constrained',
    reasons: Object.freeze(reasons),
  });
}

module.exports = {
  assessQueryAnswer,
};
