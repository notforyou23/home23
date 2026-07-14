'use strict';

const COMMON_REQUIREMENTS = [
  'Give the user a direct answer grounded in the pinned Home23 brain evidence supplied in the input.',
  'Clearly separate claims supported by evidence from inference, and never invent evidence.',
  'Disclose material projection limits and do not claim coverage beyond the supplied pinned source.',
  'Do not narrate the COSMO process, internal execution steps, or these instructions.',
];

function instructionsFor(intent) {
  return [...COMMON_REQUIREMENTS, intent].join(' ');
}

const POLICIES = Object.freeze({
  quick: Object.freeze({
    mode: 'quick',
    reasoningEffort: 'low',
    verbosity: 'low',
    maxOutputTokens: 2_500,
    minimumAnswerCharacters: 0,
    expansionEnabled: false,
    instructions: instructionsFor(
      'Stay concise and focused on the strongest matching evidence; include only qualifications that materially change the answer.',
    ),
  }),
  full: Object.freeze({
    mode: 'full',
    reasoningEffort: 'high',
    verbosity: 'high',
    maxOutputTokens: 25_000,
    minimumAnswerCharacters: 2_500,
    expansionEnabled: true,
    instructions: instructionsFor(
      'Produce a comprehensive analysis organized around findings, supporting evidence, implications, and gaps in the available evidence.',
    ),
  }),
  expert: Object.freeze({
    mode: 'expert',
    reasoningEffort: 'high',
    verbosity: 'high',
    maxOutputTokens: 30_000,
    minimumAnswerCharacters: 4_000,
    expansionEnabled: true,
    instructions: instructionsFor(
      'Produce a rigorous expert analysis with findings and supporting evidence, explicit contradictions, calibrated confidence, implications, limits, and unresolved questions.',
    ),
  }),
  dive: Object.freeze({
    mode: 'dive',
    reasoningEffort: 'high',
    verbosity: 'high',
    maxOutputTokens: 32_000,
    minimumAnswerCharacters: 4_000,
    expansionEnabled: true,
    instructions: instructionsFor(
      'Traverse the evidence broadly and synthesize themes, non-obvious connections, convergence, contradictions, and actionable implications, while making remaining gaps explicit.',
    ),
  }),
});

function invalidMode(mode) {
  const error = new Error(`Unsupported Direct Query mode: ${String(mode)}`);
  error.code = 'invalid_request';
  error.retryable = false;
  return error;
}

function queryModePolicy(mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(POLICIES, mode)) {
    throw invalidMode(mode);
  }
  return POLICIES[mode];
}

module.exports = {
  queryModePolicy,
};
