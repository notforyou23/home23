'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SUPPORT_MODULE = '../../shared/query/verified-follow-up-support.cjs';

function loadSupport() {
  let loaded;
  assert.doesNotThrow(() => { loaded = require(SUPPORT_MODULE); });
  return loaded;
}

function assertFrozenDataObject(value) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    assert.equal(Object.hasOwn(descriptor, 'value'), true);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.enumerable, true);
  }
}

function noncanonicalBase64UrlAlias(authentication) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const finalCharacter = authentication.at(-1);
  const index = alphabet.indexOf(finalCharacter);
  assert.notEqual(index, -1);
  assert.equal(index % 4, 0, '32-byte HMAC base64url ends on a canonical 4-step index');
  return `${authentication.slice(0, -1)}${alphabet[index + 1]}`;
}

test('verified follow-up support defines exact immutable component and runtime receipts', () => {
  const {
    VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT,
    VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
  } = loadSupport();
  assert.deepEqual(VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT, {
    protectedStarter: {
      feature: 'verified-follow-up', version: 1, component: 'protected-starter',
      acceptanceReadinessGate: true, acceptedReplayBeforeReadiness: true,
    },
    coordinator: {
      feature: 'verified-follow-up', version: 1, component: 'coordinator',
      specializedStart: true, privateContextInjection: true, recoveryInjection: true,
    },
    store: {
      feature: 'verified-follow-up', version: 1, component: 'store',
      privatePersistence: true, requesterBoundLineageRead: true,
      requesterBoundContextRead: true,
    },
    reader: {
      feature: 'verified-follow-up', version: 1, component: 'reader',
      requesterBoundLineageRead: true, requesterBoundContextRead: true,
    },
  });
  assertFrozenDataObject(VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT);
  for (const receipt of Object.values(VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT)) {
    assertFrozenDataObject(receipt);
  }
  assert.deepEqual(VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT, {
    feature: 'verified-follow-up',
    version: 1,
    projection: 'follow-up-v1',
    maxUtf16: 20_000,
    workerCanonicalValidation: true,
    engineInitialPrompt: true,
    engineExpansionPrompt: true,
    engineCacheIdentity: true,
  });
  assertFrozenDataObject(VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT);
});

test('component support accepts only exact immutable data receipts on immutable properties', () => {
  const {
    VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT,
    hasExactVerifiedFollowUpComponentSupport,
  } = loadSupport();
  const realLike = {};
  Object.defineProperty(realLike, 'verifiedFollowUpSupport', {
    value: VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT.store,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  assert.equal(hasExactVerifiedFollowUpComponentSupport(realLike, 'store'), true);
  assert.equal(hasExactVerifiedFollowUpComponentSupport({}, 'store'), false);
  assert.equal(hasExactVerifiedFollowUpComponentSupport({
    verifiedFollowUpSupport: VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT.store,
  }, 'store'), false, 'mutable component property');

  const mutableReceipt = JSON.parse(JSON.stringify(VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT.store));
  const mutable = {};
  Object.defineProperty(mutable, 'verifiedFollowUpSupport', {
    value: mutableReceipt, enumerable: true, writable: false, configurable: false,
  });
  assert.equal(hasExactVerifiedFollowUpComponentSupport(mutable, 'store'), false);

  const withExtra = {};
  Object.defineProperty(withExtra, 'verifiedFollowUpSupport', {
    value: Object.freeze({ ...VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT.store, surprise: true }),
    enumerable: true, writable: false, configurable: false,
  });
  assert.equal(hasExactVerifiedFollowUpComponentSupport(withExtra, 'store'), false);

  const drifted = {};
  Object.defineProperty(drifted, 'verifiedFollowUpSupport', {
    value: Object.freeze({ ...VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT.store, version: 2 }),
    enumerable: true, writable: false, configurable: false,
  });
  assert.equal(hasExactVerifiedFollowUpComponentSupport(drifted, 'store'), false);

  const getter = {};
  Object.defineProperty(getter, 'verifiedFollowUpSupport', {
    get() { return VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT.store; },
    enumerable: true,
    configurable: false,
  });
  assert.equal(hasExactVerifiedFollowUpComponentSupport(getter, 'store'), false);
  assert.equal(hasExactVerifiedFollowUpComponentSupport(realLike, 'unknown'), false);
});

test('runtime support rejects mutable, additional, and drifted fields', () => {
  const {
    VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    isExactVerifiedFollowUpRuntimeSupport,
  } = loadSupport();
  assert.equal(isExactVerifiedFollowUpRuntimeSupport(VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT), true);
  assert.equal(isExactVerifiedFollowUpRuntimeSupport(
    JSON.parse(JSON.stringify(VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT)),
  ), false);
  assert.equal(isExactVerifiedFollowUpRuntimeSupport(Object.freeze({
    ...VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    version: 2,
  })), false);
  assert.equal(isExactVerifiedFollowUpRuntimeSupport(Object.freeze({
    ...VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    extra: true,
  })), false);
  const getter = {};
  for (const [key, value] of Object.entries(VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT)) {
    Object.defineProperty(getter, key, key === 'maxUtf16'
      ? { get() { return value; }, enumerable: true, configurable: false }
      : { value, enumerable: true, writable: false, configurable: false });
  }
  Object.preventExtensions(getter);
  assert.equal(isExactVerifiedFollowUpRuntimeSupport(getter), false);
});

test('support handshake authenticates an exact nonce-bound runtime receipt without key disclosure', () => {
  const support = loadSupport();
  const key = 'test-capability-key-with-enough-entropy';
  const now = Date.parse('2026-07-21T16:00:00.000Z');
  const requestEnvelope = support.createVerifiedFollowUpSupportRequest({
    key,
    now,
    randomBytes: () => Buffer.alloc(24, 7),
  });
  assert.deepEqual(Object.keys(requestEnvelope).sort(), ['authorization', 'request']);
  assert.deepEqual(requestEnvelope.request, {
    version: 1,
    issuedAt: now,
    nonce: `vfhs_${Buffer.alloc(24, 7).toString('base64url')}`,
  });
  assert.equal(JSON.stringify(requestEnvelope.request).includes(key), false);
  assert.match(requestEnvelope.authorization, /^vfh1\.[A-Za-z0-9_-]{43}$/);

  const response = support.createVerifiedFollowUpSupportResponse({
    key,
    request: requestEnvelope.request,
    authorization: requestEnvelope.authorization,
    runtimeSupport: support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    now: now + 1,
  });
  assert.deepEqual(Object.keys(response).sort(), [
    'authentication', 'issuedAt', 'nonce', 'support', 'version',
  ]);
  assert.equal(Object.hasOwn(response.support, 'authentication'), false);
  assert.equal(JSON.stringify(response).includes(key), false);

  const verified = support.verifyVerifiedFollowUpSupportResponse({
    key,
    request: requestEnvelope.request,
    response: JSON.parse(JSON.stringify(response)),
    now: now + 2,
  });
  assert.deepEqual(verified, support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT);
  assertFrozenDataObject(verified);
  assert.equal(support.isAuthenticatedVerifiedFollowUpRuntimeSupport(verified), true);
  assert.equal(
    support.isAuthenticatedVerifiedFollowUpRuntimeSupport(
      Object.freeze({ ...support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT }),
    ),
    false,
  );
});

test('support handshake fails closed for absent keys, stale requests, tampering, and nonce mismatch', () => {
  const support = loadSupport();
  const key = 'test-capability-key-with-enough-entropy';
  const wrongKey = 'wrong-capability-key-with-enough-entropy';
  const now = Date.parse('2026-07-21T16:00:00.000Z');
  assert.throws(() => support.createVerifiedFollowUpSupportRequest({ key: '', now }), {
    code: 'capability_unavailable',
  });
  const envelope = support.createVerifiedFollowUpSupportRequest({
    key, now, randomBytes: () => Buffer.alloc(24, 8),
  });
  assert.throws(() => support.createVerifiedFollowUpSupportResponse({
    key: wrongKey,
    request: envelope.request,
    authorization: envelope.authorization,
    runtimeSupport: support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    now,
  }), { code: 'capability_invalid' });
  assert.throws(() => support.createVerifiedFollowUpSupportResponse({
    key,
    request: { ...envelope.request, extra: true },
    authorization: envelope.authorization,
    runtimeSupport: support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    now,
  }), { code: 'capability_invalid' });
  assert.throws(() => support.createVerifiedFollowUpSupportResponse({
    key,
    request: envelope.request,
    authorization: envelope.authorization,
    runtimeSupport: support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    now: now + support.VERIFIED_FOLLOW_UP_HANDSHAKE_TTL_MS + 1,
  }), { code: 'capability_expired' });

  const response = support.createVerifiedFollowUpSupportResponse({
    key,
    request: envelope.request,
    authorization: envelope.authorization,
    runtimeSupport: support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    now,
  });
  for (const tampered of [
    { ...response, nonce: `vfhs_${Buffer.alloc(24, 9).toString('base64url')}` },
    { ...response, support: { ...response.support, version: 2 } },
    { ...response, authentication: `${response.authentication.slice(0, -1)}A` },
    { ...response, extra: true },
  ]) {
    assert.throws(() => support.verifyVerifiedFollowUpSupportResponse({
      key, request: envelope.request, response: tampered, now: now + 1,
    }), { code: 'capability_invalid' });
  }
  assert.throws(() => support.verifyVerifiedFollowUpSupportResponse({
    key: wrongKey, request: envelope.request, response, now: now + 1,
  }), { code: 'capability_invalid' });

  assert.throws(() => support.createVerifiedFollowUpSupportResponse({
    key,
    request: envelope.request,
    authorization: noncanonicalBase64UrlAlias(envelope.authorization),
    runtimeSupport: support.VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
    now,
  }), { code: 'capability_invalid' });
  assert.throws(() => support.verifyVerifiedFollowUpSupportResponse({
    key,
    request: envelope.request,
    response: {
      ...response,
      authentication: noncanonicalBase64UrlAlias(response.authentication),
    },
    now: now + 1,
  }), { code: 'capability_invalid' });
});
