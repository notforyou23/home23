import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityMembrane } from '../src/membrane.js';
import { CapabilityDeniedError } from '../src/types.js';

test('all Cut 1 allowed capabilities pass', () => {
  const m = new CapabilityMembrane();
  const allowed = [
    'local.ledger.append',
    'local.state.read',
    'local.state.write',
    'local.checkpoint.write',
    'local.checkpoint.read',
    'local.source.ingest',
    'local.resource.account',
  ] as const;
  for (const cap of allowed) {
    assert.doesNotThrow(() => m.assert(cap), `${cap} should be allowed`);
    assert.ok(m.isAllowed(cap), `isAllowed(${cap}) should be true`);
  }
});

test('all explicitly forbidden capabilities throw CapabilityDeniedError', () => {
  const m = new CapabilityMembrane();
  const forbidden = [
    'home23.engine.modify',
    'home23.config.modify',
    'home23.memory.write',
    'home23.identity.modify',
    'home23.relationship.modify',
    'home23.agency.modify',
    'home23.cron.modify',
    'home23.project.modify',
    'net.publish',
    'net.message.external',
    'device.control',
    'script.execute',
    'secret.read',
    'membrane.modify',
    'ledger.trusted.modify',
    'seed.replicate',
    'seed.authority.expand',
  ] as const;

  for (const cap of forbidden) {
    assert.throws(
      () => m.assert(cap),
      (err) => err instanceof CapabilityDeniedError,
      `${cap} should throw CapabilityDeniedError`,
    );
    assert.ok(!m.isAllowed(cap), `isAllowed(${cap}) should be false`);
  }
});

test('unknown capability is denied by default', () => {
  const m = new CapabilityMembrane();
  assert.throws(
    () => m.assert('unknown.capability.xyz' as never),
    (err) => err instanceof CapabilityDeniedError && err.capability === 'unknown.capability.xyz',
  );
  assert.ok(!m.isAllowed('unknown.capability.xyz' as never));
});

test('membrane cannot modify itself: membrane.modify is forbidden', () => {
  const m = new CapabilityMembrane();
  assert.throws(
    () => m.assert('membrane.modify'),
    (err) => err instanceof CapabilityDeniedError,
  );
});

test('allowedCapabilities returns a read-only view of allowed set', () => {
  const m = new CapabilityMembrane();
  const allowed = m.allowedCapabilities();
  assert.ok(allowed.has('local.ledger.append'));
  assert.ok(!allowed.has('net.publish' as never));
});

test('forbiddenCapabilities returns the forbidden set', () => {
  const m = new CapabilityMembrane();
  const forbidden = m.forbiddenCapabilities();
  assert.ok(forbidden.has('home23.engine.modify'));
  assert.ok(!forbidden.has('local.ledger.append' as never));
});

test('CapabilityDeniedError has the correct capability and message', () => {
  const m = new CapabilityMembrane();
  let caught: unknown;
  try {
    m.assert('script.execute');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CapabilityDeniedError);
  assert.equal(caught.capability, 'script.execute');
  assert.ok(caught.message.includes('script.execute'));
  assert.equal(caught.name, 'CapabilityDeniedError');
});
