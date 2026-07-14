'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessQueryAnswer } = require('../../cosmo23/lib/query-answer-quality');

function structuredAnswer(length = 4_500) {
  const structure = [
    '# Findings',
    '# Evidence and inference',
    '# Themes',
    '# Non-obvious connections',
    '# Convergence',
    '# Contradictions',
    '# Confidence',
    '# Actionable implications',
    '# Gaps and unresolved questions',
    'Projection limits: this answer uses the retained prompt subset, not the entire brain.',
  ].join('\n\n');
  return `${structure}\n\n${'Detailed supported analysis. '.repeat(length)}`.slice(0, length);
}

test('thin Dive requests one expansion for healthy evidence', () => {
  assert.deepEqual(assessQueryAnswer({
    mode: 'dive',
    answer: 'short',
    healthyEvidence: true,
    projection: { nodesRetained: 80, byteBudgetTruncated: true },
  }), {
    quality: 'constrained',
    shouldExpand: true,
    reasons: ['answer_too_short', 'missing_required_structure'],
  });
});

test('substantial structured long-mode answers do not expand', () => {
  for (const mode of ['full', 'expert', 'dive']) {
    assert.deepEqual(assessQueryAnswer({
      mode,
      answer: structuredAnswer(),
      healthyEvidence: true,
      projection: { nodesRetained: 80, promptReduced: true },
    }), {
      quality: 'substantial',
      shouldExpand: false,
      reasons: [],
    });
  }
});

test('Quick never expands and unhealthy evidence remains constrained', () => {
  assert.deepEqual(assessQueryAnswer({
    mode: 'quick', answer: 'short', healthyEvidence: true, projection: {},
  }), {
    quality: 'not-required',
    shouldExpand: false,
    reasons: [],
  });
  assert.deepEqual(assessQueryAnswer({
    mode: 'expert', answer: 'short', healthyEvidence: false, projection: {},
  }), {
    quality: 'constrained',
    shouldExpand: false,
    reasons: ['evidence_constrained', 'answer_too_short', 'missing_required_structure'],
  });
});

test('long answers still require their selected mode structure', () => {
  const unstructured = 'A'.repeat(5_000);
  for (const mode of ['full', 'expert', 'dive']) {
    const assessment = assessQueryAnswer({
      mode,
      answer: unstructured,
      healthyEvidence: true,
      projection: { nodesRetained: 100 },
    });
    assert.equal(assessment.quality, 'constrained');
    assert.equal(assessment.shouldExpand, true);
    assert.deepEqual(assessment.reasons, ['missing_required_structure']);
  }
});
