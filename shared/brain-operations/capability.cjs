'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const { canonicalJson } = require('./canonical-json.cjs');

const CAPABILITY_VERSION = 1;
const CAPABILITY_MAX_TTL_MS = 120_000;
const FUTURE_SKEW_MS = 5_000;
const CLAIM_FIELDS = Object.freeze([
  'requesterAgent',
  'targetDomain',
  'targetBrainId',
  'targetRunId',
  'targetRequesterAgent',
  'canonicalRoot',
  'accessMode',
  'operationType',
  'operationId',
  'sourcePinDigest',
  'issuedAt',
  'expiresAt',
  'nonce',
]);
const BINDING_FIELDS = Object.freeze([...CLAIM_FIELDS]);

function capabilityError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertKey(key) {
  const valid = (typeof key === 'string' && key.length > 0)
    || (Buffer.isBuffer(key) && key.length > 0);
  if (!valid) throw capabilityError('capability_unavailable');
}

function safeClaimsCopy(value, includeVersion) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw capabilityError('capability_invalid');
  }
  let copy;
  try {
    copy = JSON.parse(canonicalJson(value));
  } catch (error) {
    throw capabilityError('capability_invalid', error);
  }
  const expectedKeys = includeVersion ? ['v', ...CLAIM_FIELDS] : [...CLAIM_FIELDS];
  const keys = Object.keys(copy).sort();
  if (keys.length !== expectedKeys.length
      || !expectedKeys.every((field) => Object.hasOwn(copy, field))) {
    throw capabilityError('capability_invalid');
  }
  return copy;
}

function validateShape(claims) {
  for (const field of ['requesterAgent', 'accessMode', 'operationType', 'operationId', 'nonce']) {
    if (typeof claims[field] !== 'string' || !claims[field].trim()) {
      throw capabilityError('capability_invalid');
    }
  }
  if (!Number.isFinite(claims.issuedAt) || !Number.isFinite(claims.expiresAt)) {
    throw capabilityError('capability_expired');
  }
  if (claims.expiresAt <= claims.issuedAt
      || claims.expiresAt - claims.issuedAt > CAPABILITY_MAX_TTL_MS) {
    throw capabilityError('capability_expired');
  }

  const pinValid = claims.sourcePinDigest === null
    || (typeof claims.sourcePinDigest === 'string'
      && /^sha256:[a-f0-9]{64}$/.test(claims.sourcePinDigest));
  if (!pinValid) throw capabilityError('capability_invalid');

  const brain = claims.targetDomain === 'brain'
    && typeof claims.targetBrainId === 'string' && claims.targetBrainId.trim()
    && claims.targetRunId === null && claims.targetRequesterAgent === null
    && typeof claims.canonicalRoot === 'string' && path.isAbsolute(claims.canonicalRoot);
  const ownedRun = claims.targetDomain === 'owned-run'
    && claims.targetBrainId === null
    && typeof claims.targetRunId === 'string' && claims.targetRunId.trim()
    && claims.targetRequesterAgent === null
    && typeof claims.canonicalRoot === 'string' && path.isAbsolute(claims.canonicalRoot);
  const requester = claims.targetDomain === 'requester'
    && claims.targetBrainId === null && claims.targetRunId === null
    && claims.targetRequesterAgent === claims.requesterAgent
    && claims.canonicalRoot === null;
  if (!brain && !ownedRun && !requester) throw capabilityError('capability_invalid');
}

function issueCapability(key, rawClaims) {
  assertKey(key);
  const claims = safeClaimsCopy(rawClaims, false);
  validateShape(claims);
  const payload = Buffer.from(canonicalJson({ v: CAPABILITY_VERSION, ...claims }), 'utf8')
    .toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeCanonicalBase64Url(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw capabilityError('capability_invalid');
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch (error) {
    throw capabilityError('capability_invalid', error);
  }
  if (bytes.toString('base64url') !== value) throw capabilityError('capability_invalid');
  return bytes;
}

function verifyCapability(key, token, expected) {
  assertKey(key);
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw capabilityError('capability_invalid');
  }
  const [payload, supplied] = parts;
  const suppliedBytes = decodeCanonicalBase64Url(supplied);
  if (suppliedBytes.length !== 32) throw capabilityError('capability_invalid');
  const calculated = createHmac('sha256', key).update(payload).digest();
  if (!timingSafeEqual(calculated, suppliedBytes)) throw capabilityError('capability_invalid');

  const payloadBytes = decodeCanonicalBase64Url(payload);
  let decoded;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8'));
  } catch (error) {
    throw capabilityError('capability_invalid', error);
  }
  const wireClaims = safeClaimsCopy(decoded, true);
  if (wireClaims.v !== CAPABILITY_VERSION) throw capabilityError('capability_version');
  const claims = Object.fromEntries(CLAIM_FIELDS.map((field) => [field, wireClaims[field]]));
  validateShape(claims);

  if (!expected || !Number.isFinite(expected.now)) throw capabilityError('capability_invalid');
  if (claims.issuedAt > expected.now + FUTURE_SKEW_MS
      || claims.expiresAt <= expected.now) {
    throw capabilityError('capability_expired');
  }
  for (const field of BINDING_FIELDS) {
    if (!Object.hasOwn(expected, field) || claims[field] !== expected[field]) {
      throw capabilityError('capability_mismatch');
    }
  }
  return claims;
}

module.exports = {
  CAPABILITY_MAX_TTL_MS,
  CAPABILITY_VERSION,
  capabilityError,
  issueCapability,
  verifyCapability,
};
