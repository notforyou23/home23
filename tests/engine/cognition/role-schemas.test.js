import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_SCHEMAS, validateRoleOutput } from '../../../engine/src/cognition/role-schemas.mjs';

test('ROLE_SCHEMAS has entries for the five phase roles', () => {
  for (const role of ['critic', 'discovery', 'deep_dive', 'connect', 'curator']) {
    assert.ok(ROLE_SCHEMAS[role], `missing schema for ${role}`);
    assert.ok(Array.isArray(ROLE_SCHEMAS[role].required), `${role} schema missing required[]`);
  }
});

test('validateRoleOutput passes everything in soft mode', () => {
  const r = validateRoleOutput('critic', { anything: true }, { strict: false });
  assert.equal(r.valid, true);
});

test('validateRoleOutput rejects unknown role', () => {
  const r = validateRoleOutput('unknown_role', {}, { strict: true });
  assert.equal(r.valid, false);
  assert.match(r.reason, /unknown role/);
});

test('validateRoleOutput strict rejects missing required fields', () => {
  const r = validateRoleOutput('critic', { claim: 'x' }, { strict: true });
  assert.equal(r.valid, false);
  assert.match(r.reason, /missing fields/);
});
