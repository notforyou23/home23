'use strict';

const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');
const { canonicalJson } = require('./brain-operations/canonical-json.cjs');

const MCP_REQUEST_IDENTITY_SCHEMA = 'home23.mcp-request-identity.v1';
const MCP_REQUEST_IDENTITY_VERSION = 1;
const MCP_REQUEST_IDENTITY_MAX_TTL_MS = 120_000;
const FUTURE_SKEW_MS = 5_000;
const MAX_REPLAY_NONCES = 2_048;
const CLAIM_FIELDS = Object.freeze([
  'agent',
  'audience',
  'method',
  'path',
  'bodyDigest',
  'issuedAt',
  'expiresAt',
  'nonce',
]);
const EXPECTED_BINDINGS = Object.freeze([
  'audience',
  'method',
  'path',
  'bodyDigest',
]);
const replayNonces = new Map();

function mcpRequestIdentityError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertRootKey(key) {
  const valid = (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key))
    || (Buffer.isBuffer(key) && key.length === 32);
  if (!valid) throw mcpRequestIdentityError('mcp_request_identity_unavailable');
}

function deriveSigningKey(rootKey) {
  assertRootKey(rootKey);
  return createHmac('sha256', rootKey)
    .update(MCP_REQUEST_IDENTITY_SCHEMA)
    .digest();
}

function exactCopy(value, expectedFields) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  let copy;
  try {
    copy = JSON.parse(canonicalJson(value));
  } catch (error) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid', error);
  }
  const keys = Object.keys(copy).sort();
  const wanted = [...expectedFields].sort();
  if (keys.length !== wanted.length || !wanted.every((field) => Object.hasOwn(copy, field))) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  return copy;
}

function validateClaims(claims) {
  if (typeof claims.agent !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(claims.agent)
      || typeof claims.audience !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(claims.audience)
      || typeof claims.method !== 'string'
      || !/^[A-Z]{1,16}$/.test(claims.method)
      || typeof claims.path !== 'string'
      || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,1023}$/.test(claims.path)
      || typeof claims.bodyDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(claims.bodyDigest)
      || typeof claims.nonce !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(claims.nonce)) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
      || claims.expiresAt <= claims.issuedAt
      || claims.expiresAt - claims.issuedAt > MCP_REQUEST_IDENTITY_MAX_TTL_MS) {
    throw mcpRequestIdentityError('mcp_request_identity_expired');
  }
}

function decodeCanonicalBase64Url(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch (error) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid', error);
  }
  if (bytes.toString('base64url') !== value) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  return bytes;
}

function mcpRequestBodyDigest(body) {
  let canonical;
  try {
    canonical = canonicalJson(body);
  } catch (error) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid', error);
  }
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function issueMcpRequestIdentity(rootKey, rawClaims) {
  const signingKey = deriveSigningKey(rootKey);
  const inputFields = rawClaims && Object.hasOwn(rawClaims, 'nonce')
    ? CLAIM_FIELDS
    : CLAIM_FIELDS.filter((field) => field !== 'nonce');
  const copied = exactCopy(rawClaims, inputFields);
  const claims = {
    ...copied,
    nonce: copied.nonce || randomBytes(24).toString('base64url'),
  };
  validateClaims(claims);
  const payload = Buffer.from(canonicalJson({
    v: MCP_REQUEST_IDENTITY_VERSION,
    schema: MCP_REQUEST_IDENTITY_SCHEMA,
    ...claims,
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function pruneReplayNonces(now) {
  for (const [nonce, expiresAt] of replayNonces) {
    if (expiresAt <= now) replayNonces.delete(nonce);
  }
  while (replayNonces.size >= MAX_REPLAY_NONCES) {
    replayNonces.delete(replayNonces.keys().next().value);
  }
}

function verifyMcpRequestIdentity(rootKey, token, expected) {
  const signingKey = deriveSigningKey(rootKey);
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  const [payloadPart, suppliedPart] = parts;
  const supplied = decodeCanonicalBase64Url(suppliedPart);
  if (supplied.length !== 32) throw mcpRequestIdentityError('mcp_request_identity_invalid');
  const calculated = createHmac('sha256', signingKey).update(payloadPart).digest();
  if (!timingSafeEqual(calculated, supplied)) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }

  const payloadBytes = decodeCanonicalBase64Url(payloadPart);
  let decoded;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8'));
  } catch (error) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid', error);
  }
  const wire = exactCopy(decoded, ['v', 'schema', ...CLAIM_FIELDS]);
  if (wire.v !== MCP_REQUEST_IDENTITY_VERSION || wire.schema !== MCP_REQUEST_IDENTITY_SCHEMA) {
    throw mcpRequestIdentityError('mcp_request_identity_version');
  }
  if (canonicalJson(wire) !== payloadBytes.toString('utf8')) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  const claims = Object.fromEntries(CLAIM_FIELDS.map((field) => [field, wire[field]]));
  validateClaims(claims);

  if (!expected || !Number.isSafeInteger(expected.now)) {
    throw mcpRequestIdentityError('mcp_request_identity_invalid');
  }
  if (claims.issuedAt > expected.now + FUTURE_SKEW_MS || claims.expiresAt <= expected.now) {
    throw mcpRequestIdentityError('mcp_request_identity_expired');
  }
  for (const field of EXPECTED_BINDINGS) {
    if (!Object.hasOwn(expected, field) || claims[field] !== expected[field]) {
      throw mcpRequestIdentityError('mcp_request_identity_mismatch');
    }
  }
  if (Object.hasOwn(expected, 'agent') && claims.agent !== expected.agent) {
    throw mcpRequestIdentityError('mcp_request_identity_mismatch');
  }

  pruneReplayNonces(expected.now);
  if (replayNonces.has(claims.nonce)) {
    throw mcpRequestIdentityError('mcp_request_identity_replayed');
  }
  replayNonces.set(claims.nonce, claims.expiresAt);
  return Object.freeze(claims);
}

module.exports = {
  MCP_REQUEST_IDENTITY_MAX_TTL_MS,
  MCP_REQUEST_IDENTITY_SCHEMA,
  MCP_REQUEST_IDENTITY_VERSION,
  issueMcpRequestIdentity,
  mcpRequestBodyDigest,
  mcpRequestIdentityError,
  verifyMcpRequestIdentity,
};
