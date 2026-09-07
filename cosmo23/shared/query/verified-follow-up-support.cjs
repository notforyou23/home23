'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../brain-operations/canonical-json.cjs');

const VERIFIED_FOLLOW_UP_HANDSHAKE_TTL_MS = 10_000;
const VERIFIED_FOLLOW_UP_HANDSHAKE_FUTURE_SKEW_MS = 1_000;
const HANDSHAKE_AUTH_PATTERN = /^vfh1\.([A-Za-z0-9_-]{43})$/;
const HANDSHAKE_NONCE_PATTERN = /^vfhs_[A-Za-z0-9_-]{32}$/;
const REQUEST_DOMAIN = 'home23.query.verified-follow-up.support.request.v1';
const RESPONSE_DOMAIN = 'home23.query.verified-follow-up.support.response.v1';
const authenticatedRuntimeReceipts = new WeakSet();

function frozenReceipt(value) {
  return Object.freeze({ ...value });
}

const VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT = Object.freeze({
  protectedStarter: frozenReceipt({
    feature: 'verified-follow-up',
    version: 1,
    component: 'protected-starter',
    acceptanceReadinessGate: true,
    acceptedReplayBeforeReadiness: true,
  }),
  coordinator: frozenReceipt({
    feature: 'verified-follow-up',
    version: 1,
    component: 'coordinator',
    specializedStart: true,
    privateContextInjection: true,
    recoveryInjection: true,
  }),
  store: frozenReceipt({
    feature: 'verified-follow-up',
    version: 1,
    component: 'store',
    privatePersistence: true,
    requesterBoundLineageRead: true,
    requesterBoundContextRead: true,
  }),
  reader: frozenReceipt({
    feature: 'verified-follow-up',
    version: 1,
    component: 'reader',
    requesterBoundLineageRead: true,
    requesterBoundContextRead: true,
  }),
});

const VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT = frozenReceipt({
  feature: 'verified-follow-up',
  version: 1,
  projection: 'follow-up-v1',
  maxUtf16: 20_000,
  workerCanonicalValidation: true,
  engineInitialPrompt: true,
  engineExpansionPrompt: true,
  engineCacheIdentity: true,
});

function isExactFrozenDataReceipt(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.getPrototypeOf(value) !== Object.prototype
      || !Object.isFrozen(value)) return false;
  const actualKeys = Reflect.ownKeys(value);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.some((key) => typeof key !== 'string')
      || actualKeys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(value, key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return expectedKeys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor
      && Object.hasOwn(descriptor, 'value')
      && descriptor.enumerable === true
      && descriptor.writable === false
      && descriptor.configurable === false
      && Object.is(descriptor.value, expected[key]);
  });
}

function supportError(code) {
  return Object.assign(new Error(code), { code });
}

function assertKey(key) {
  const valid = (typeof key === 'string' && Buffer.byteLength(key, 'utf8') > 0)
    || (Buffer.isBuffer(key) && key.length > 0);
  if (!valid) throw supportError('capability_unavailable');
}

function exactDataObject(value, expectedKeys) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(value, key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return expectedKeys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
  });
}

function isExactWireReceipt(value, expected) {
  return exactDataObject(value, Object.keys(expected))
    && Object.keys(expected).every((key) => Object.is(value[key], expected[key]));
}

function normalizeNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw supportError('capability_invalid');
  return value;
}

function validateHandshakeTime(issuedAt, now) {
  if (!Number.isSafeInteger(issuedAt)
      || issuedAt > now + VERIFIED_FOLLOW_UP_HANDSHAKE_FUTURE_SKEW_MS
      || issuedAt < now - VERIFIED_FOLLOW_UP_HANDSHAKE_TTL_MS) {
    throw supportError('capability_expired');
  }
}

function validateRequest(request, now) {
  if (!exactDataObject(request, ['version', 'issuedAt', 'nonce'])
      || request.version !== 1
      || typeof request.nonce !== 'string'
      || !HANDSHAKE_NONCE_PATTERN.test(request.nonce)) {
    throw supportError('capability_invalid');
  }
  validateHandshakeTime(request.issuedAt, now);
  return request;
}

function authenticationFor(key, domain, value) {
  assertKey(key);
  return `vfh1.${crypto.createHmac('sha256', key)
    .update(canonicalJson({ domain, value }), 'utf8')
    .digest('base64url')}`;
}

function authenticationMatches(key, domain, value, supplied) {
  assertKey(key);
  const match = typeof supplied === 'string' ? HANDSHAKE_AUTH_PATTERN.exec(supplied) : null;
  if (!match) return false;
  const expected = Buffer.from(authenticationFor(key, domain, value).slice('vfh1.'.length), 'base64url');
  const received = Buffer.from(match[1], 'base64url');
  return received.length === 32
    && received.toString('base64url') === match[1]
    && expected.length === received.length
    && crypto.timingSafeEqual(expected, received);
}

function createVerifiedFollowUpSupportRequest({ key, now = Date.now(), randomBytes = crypto.randomBytes } = {}) {
  assertKey(key);
  const issuedAt = normalizeNow(now);
  if (typeof randomBytes !== 'function') throw supportError('capability_unavailable');
  let nonceBytes;
  try { nonceBytes = randomBytes(24); } catch { throw supportError('capability_unavailable'); }
  if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 24) {
    throw supportError('capability_unavailable');
  }
  const request = frozenReceipt({
    version: 1,
    issuedAt,
    nonce: `vfhs_${nonceBytes.toString('base64url')}`,
  });
  return Object.freeze({
    request,
    authorization: authenticationFor(key, REQUEST_DOMAIN, request),
  });
}

function createVerifiedFollowUpSupportResponse({
  key,
  request,
  authorization,
  runtimeSupport,
  now = Date.now(),
} = {}) {
  const issuedAt = normalizeNow(now);
  validateRequest(request, issuedAt);
  if (!authenticationMatches(key, REQUEST_DOMAIN, request, authorization)) {
    throw supportError('capability_invalid');
  }
  if (!isExactVerifiedFollowUpRuntimeSupport(runtimeSupport)) {
    throw supportError('verified_follow_up_support_unavailable');
  }
  const unsigned = frozenReceipt({
    version: 1,
    issuedAt,
    nonce: request.nonce,
    support: runtimeSupport,
  });
  return frozenReceipt({
    ...unsigned,
    authentication: authenticationFor(key, RESPONSE_DOMAIN, unsigned),
  });
}

function verifyVerifiedFollowUpSupportResponse({
  key,
  request,
  response,
  now = Date.now(),
} = {}) {
  const observedAt = normalizeNow(now);
  validateRequest(request, observedAt);
  if (!exactDataObject(response, [
    'version', 'issuedAt', 'nonce', 'support', 'authentication',
  ])
      || response.version !== 1
      || response.nonce !== request.nonce
      || response.issuedAt < request.issuedAt - VERIFIED_FOLLOW_UP_HANDSHAKE_FUTURE_SKEW_MS
      || !isExactWireReceipt(response.support, VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT)) {
    throw supportError('capability_invalid');
  }
  validateHandshakeTime(response.issuedAt, observedAt);
  const unsigned = {
    version: response.version,
    issuedAt: response.issuedAt,
    nonce: response.nonce,
    support: response.support,
  };
  if (!authenticationMatches(key, RESPONSE_DOMAIN, unsigned, response.authentication)) {
    throw supportError('capability_invalid');
  }
  const receipt = frozenReceipt(response.support);
  authenticatedRuntimeReceipts.add(receipt);
  return receipt;
}

function isAuthenticatedVerifiedFollowUpRuntimeSupport(value) {
  return authenticatedRuntimeReceipts.has(value)
    && isExactVerifiedFollowUpRuntimeSupport(value);
}

function hasExactVerifiedFollowUpComponentSupport(component, kind) {
  const expected = VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT[kind];
  if (!expected || !component || typeof component !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(component, 'verifiedFollowUpSupport');
  return Boolean(descriptor
    && Object.hasOwn(descriptor, 'value')
    && descriptor.enumerable === true
    && descriptor.writable === false
    && descriptor.configurable === false
    && isExactFrozenDataReceipt(descriptor.value, expected));
}

function isExactVerifiedFollowUpRuntimeSupport(value) {
  return isExactFrozenDataReceipt(value, VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT);
}

module.exports = {
  VERIFIED_FOLLOW_UP_HANDSHAKE_TTL_MS,
  VERIFIED_FOLLOW_UP_COMPONENT_SUPPORT,
  VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
  createVerifiedFollowUpSupportRequest,
  createVerifiedFollowUpSupportResponse,
  hasExactVerifiedFollowUpComponentSupport,
  isAuthenticatedVerifiedFollowUpRuntimeSupport,
  isExactVerifiedFollowUpRuntimeSupport,
  verifyVerifiedFollowUpSupportResponse,
};
