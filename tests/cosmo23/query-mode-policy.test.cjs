'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { queryModePolicy } = require('../../cosmo23/lib/query-mode-policy');

test('Direct Query modes expose four exact immutable policies', () => {
  const quick = queryModePolicy('quick');
  const full = queryModePolicy('full');
  const expert = queryModePolicy('expert');
  const dive = queryModePolicy('dive');

  assert.deepEqual({ ...quick, instructions: undefined }, {
    mode: 'quick',
    reasoningEffort: 'low',
    verbosity: 'low',
    maxOutputTokens: 2_500,
    minimumAnswerCharacters: 0,
    expansionEnabled: false,
    instructions: undefined,
  });
  assert.deepEqual({ ...full, instructions: undefined }, {
    mode: 'full',
    reasoningEffort: 'high',
    verbosity: 'high',
    maxOutputTokens: 25_000,
    minimumAnswerCharacters: 2_500,
    expansionEnabled: true,
    instructions: undefined,
  });
  assert.deepEqual({ ...expert, instructions: undefined }, {
    mode: 'expert',
    reasoningEffort: 'high',
    verbosity: 'high',
    maxOutputTokens: 30_000,
    minimumAnswerCharacters: 4_000,
    expansionEnabled: true,
    instructions: undefined,
  });
  assert.deepEqual({ ...dive, instructions: undefined }, {
    mode: 'dive',
    reasoningEffort: 'high',
    verbosity: 'high',
    maxOutputTokens: 32_000,
    minimumAnswerCharacters: 4_000,
    expansionEnabled: true,
    instructions: undefined,
  });

  for (const policy of [quick, full, expert, dive]) {
    assert.equal(Object.isFrozen(policy), true);
    assert.match(policy.instructions, /direct answer/i);
    assert.match(policy.instructions, /evidence/i);
    assert.match(policy.instructions, /inference/i);
    assert.match(policy.instructions, /projection limit/i);
    assert.match(policy.instructions, /do not narrate.*COSMO/i);
  }
  assert.match(full.instructions, /findings/i);
  assert.match(full.instructions, /implications/i);
  assert.match(full.instructions, /gaps/i);
  assert.match(expert.instructions, /contradictions/i);
  assert.match(expert.instructions, /confidence/i);
  assert.match(expert.instructions, /unresolved questions/i);
  assert.match(dive.instructions, /themes/i);
  assert.match(dive.instructions, /non-obvious connections/i);
  assert.match(dive.instructions, /convergence/i);
  assert.match(dive.instructions, /actionable implications/i);
  assert.equal(new Set([quick, full, expert, dive].map(policy => policy.instructions)).size, 4);
});

test('Direct Query rejects modes outside the validated public enum', () => {
  assert.throws(
    () => queryModePolicy('normal'),
    error => error?.code === 'invalid_request' && error?.retryable === false,
  );
  assert.throws(
    () => queryModePolicy(' full '),
    error => error?.code === 'invalid_request',
  );
});
