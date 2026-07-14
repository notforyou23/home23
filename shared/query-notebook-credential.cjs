'use strict';

const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { canonicalJson } = require('./brain-operations/canonical-json.cjs');

const QUERY_NOTEBOOK_CREDENTIAL_DOMAIN = 'home23.query-notebook.credential.v1';
const QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES = Object.freeze({
  device: 'device',
  webSession: 'web-session',
});
const AUDIENCES = new Set(Object.values(QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES));
const CLAIM_FIELDS = Object.freeze([
  'v', 'audience', 'requesterAgent', 'credentialId', 'requesterKind',
  'generation', 'issuedAt', 'expiresAt',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const CREDENTIAL_ID_PATTERN = /^qncred_[A-Za-z0-9_-]{32}$/;
const MAX_TOKEN_BYTES = 2048;
const MAX_PAYLOAD_BYTES = 1024;
const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;

function credentialError(code = 'query_credential_invalid', cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function plainObject(value, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw credentialError(code);
  }
  return value;
}

function exactKeys(value, allowed, code) {
  plainObject(value, code);
  const keys = Reflect.ownKeys(value);
  const accepted = new Set(allowed);
  if (keys.length !== accepted.size
      || keys.some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw credentialError(code);
  }
}

function allowedKeys(value, allowed, required, code) {
  plainObject(value, code);
  const accepted = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !accepted.has(key))
      || required.some((key) => !Object.hasOwn(value, key))) {
    throw credentialError(code);
  }
}

function canonicalIso(value, code) {
  if (typeof value !== 'string') throw credentialError(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value) throw credentialError(code);
  return milliseconds;
}

function nowMilliseconds(now, code) {
  const raw = now();
  const milliseconds = raw instanceof Date ? raw.getTime()
    : typeof raw === 'string' ? Date.parse(raw) : raw;
  if (!Number.isFinite(milliseconds)) throw credentialError(code);
  return Number(milliseconds);
}

function validateAgent(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw credentialError(code);
  }
  return value;
}

function validateCredentialId(value, code) {
  if (typeof value !== 'string' || !CREDENTIAL_ID_PATTERN.test(value)) {
    throw credentialError(code);
  }
  return value;
}

function validateGeneration(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw credentialError(code);
  return value;
}

function deriveQueryNotebookCredentialKey(input) {
  exactKeys(input, ['bridgeToken', 'requesterAgent'],
    'query_credential_configuration_invalid');
  validateAgent(input.requesterAgent, 'query_credential_configuration_invalid');
  if (typeof input.bridgeToken !== 'string'
      || Buffer.byteLength(input.bridgeToken, 'utf8') < 32
      || Buffer.byteLength(input.bridgeToken, 'utf8') > 4096
      || input.bridgeToken.includes('\0')) {
    throw credentialError('query_credential_configuration_invalid');
  }
  const salt = crypto.createHash('sha256')
    .update(`${QUERY_NOTEBOOK_CREDENTIAL_DOMAIN}\0agent\0${input.requesterAgent}`, 'utf8')
    .digest();
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(input.bridgeToken, 'utf8'),
    salt,
    Buffer.from(QUERY_NOTEBOOK_CREDENTIAL_DOMAIN, 'utf8'),
    32,
  ));
}

function canonicalBase64url(value, maximumBytes, code) {
  if (typeof value !== 'string' || !value || value.length > MAX_TOKEN_BYTES
      || !/^[A-Za-z0-9_-]+$/.test(value)) throw credentialError(code);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > maximumBytes || bytes.toString('base64url') !== value) {
    throw credentialError(code);
  }
  return bytes;
}

function signingInput(payloadBytes) {
  return Buffer.concat([
    Buffer.from(QUERY_NOTEBOOK_CREDENTIAL_DOMAIN, 'utf8'),
    Buffer.from([0]),
    payloadBytes,
  ]);
}

function createQueryNotebookCredentialAuthority(options) {
  allowedKeys(options, ['bridgeToken', 'requesterAgent', 'now'],
    ['bridgeToken', 'requesterAgent'], 'query_credential_configuration_invalid');
  const requesterAgent = validateAgent(
    options.requesterAgent,
    'query_credential_configuration_invalid',
  );
  const key = deriveQueryNotebookCredentialKey({
    bridgeToken: options.bridgeToken,
    requesterAgent,
  });
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw credentialError('query_credential_configuration_invalid');

  function signature(payloadBytes) {
    return crypto.createHmac('sha256', key).update(signingInput(payloadBytes)).digest();
  }

  function issue(input) {
    exactKeys(input, [
      'audience', 'credentialId', 'requesterKind', 'generation', 'expiresAt',
    ], 'invalid_request');
    if (!AUDIENCES.has(input.audience) || input.requesterKind !== input.audience) {
      throw credentialError('invalid_request');
    }
    validateCredentialId(input.credentialId, 'invalid_request');
    validateGeneration(input.generation, 'invalid_request');
    const issuedMilliseconds = nowMilliseconds(now, 'query_credential_unavailable');
    const expiresMilliseconds = canonicalIso(input.expiresAt, 'invalid_request');
    if (expiresMilliseconds <= issuedMilliseconds
        || expiresMilliseconds - issuedMilliseconds > MAX_TTL_MS) {
      throw credentialError('invalid_request');
    }
    const claims = {
      v: 1,
      audience: input.audience,
      requesterAgent,
      credentialId: input.credentialId,
      requesterKind: input.requesterKind,
      generation: input.generation,
      issuedAt: new Date(issuedMilliseconds).toISOString(),
      expiresAt: input.expiresAt,
    };
    const payloadBytes = Buffer.from(canonicalJson(claims), 'utf8');
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
      throw credentialError('query_credential_unavailable');
    }
    return `${payloadBytes.toString('base64url')}.${signature(payloadBytes).toString('base64url')}`;
  }

  function verify(token, expected) {
    try {
      allowedKeys(expected, ['audience', 'credentialId', 'requesterKind', 'generation'],
        ['audience'], 'query_credential_invalid');
      if (!AUDIENCES.has(expected.audience)) throw credentialError();
      if (Object.hasOwn(expected, 'credentialId')) {
        validateCredentialId(expected.credentialId, 'query_credential_invalid');
      }
      if (Object.hasOwn(expected, 'requesterKind')
          && !AUDIENCES.has(expected.requesterKind)) throw credentialError();
      if (Object.hasOwn(expected, 'generation')) {
        validateGeneration(expected.generation, 'query_credential_invalid');
      }
      if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
        throw credentialError();
      }
      const parts = token.split('.');
      if (parts.length !== 2) throw credentialError();
      const payloadBytes = canonicalBase64url(parts[0], MAX_PAYLOAD_BYTES,
        'query_credential_invalid');
      const supplied = canonicalBase64url(parts[1], 32, 'query_credential_invalid');
      const wanted = signature(payloadBytes);
      const comparable = supplied.length === wanted.length ? supplied : Buffer.alloc(wanted.length);
      if (!crypto.timingSafeEqual(comparable, wanted) || supplied.length !== wanted.length) {
        throw credentialError();
      }
      const claims = JSON.parse(payloadBytes.toString('utf8'));
      exactKeys(claims, CLAIM_FIELDS, 'query_credential_invalid');
      if (Buffer.from(canonicalJson(claims), 'utf8').compare(payloadBytes) !== 0
          || claims.v !== 1
          || !AUDIENCES.has(claims.audience)
          || claims.requesterKind !== claims.audience
          || claims.requesterAgent !== requesterAgent
          || claims.audience !== expected.audience
          || (expected.credentialId !== undefined
            && claims.credentialId !== expected.credentialId)
          || (expected.requesterKind !== undefined
            && claims.requesterKind !== expected.requesterKind)
          || (expected.generation !== undefined
            && claims.generation !== expected.generation)) {
        throw credentialError();
      }
      validateCredentialId(claims.credentialId, 'query_credential_invalid');
      validateGeneration(claims.generation, 'query_credential_invalid');
      const issuedMilliseconds = canonicalIso(claims.issuedAt, 'query_credential_invalid');
      const expiresMilliseconds = canonicalIso(claims.expiresAt, 'query_credential_invalid');
      const current = nowMilliseconds(now, 'query_credential_invalid');
      if (issuedMilliseconds > current || expiresMilliseconds <= current
          || expiresMilliseconds <= issuedMilliseconds
          || expiresMilliseconds - issuedMilliseconds > MAX_TTL_MS) {
        throw credentialError();
      }
      return Object.freeze({ ...claims });
    } catch (error) {
      if (error?.code === 'query_credential_invalid') throw error;
      throw credentialError('query_credential_invalid', error);
    }
  }

  return Object.freeze({ issue, verify });
}

module.exports = {
  QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES,
  QUERY_NOTEBOOK_CREDENTIAL_DOMAIN,
  createQueryNotebookCredentialAuthority,
  deriveQueryNotebookCredentialKey,
};
