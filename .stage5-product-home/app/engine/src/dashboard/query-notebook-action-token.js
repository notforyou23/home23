'use strict';

const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  assertIdentifier,
  assertOperationId,
  operationError,
} = require('./brain-operations/operation-contract.js');

const ACTION_TOKEN_DOMAIN = 'home23.query-notebook.action.v1';
const ACTIONS = new Set(['continueSweep', 'targetedRetry']);
const CLAIM_FIELDS = Object.freeze([
  'v', 'requesterAgent', 'sourceOperationId', 'action', 'issuedAt', 'expiresAt', 'nonce',
]);
const MAX_TOKEN_BYTES = 2048;
const MAX_PAYLOAD_BYTES = 1024;
const MAX_TTL_MS = 60 * 60 * 1000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function tokenError(code = 'action_token_invalid', cause) {
  return operationError(code, cause);
}

function exactKeys(value, allowed, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw tokenError(code);
  const keys = Reflect.ownKeys(value);
  const accepted = new Set(allowed);
  if (keys.length !== accepted.size
      || keys.some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw tokenError(code);
  }
}

function allowedKeys(value, allowed, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw tokenError(code);
  const accepted = new Set(allowed);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw tokenError(code);
  }
}

function nowMs(now, code) {
  const raw = now();
  const milliseconds = raw instanceof Date ? raw.getTime()
    : typeof raw === 'string' ? Date.parse(raw) : raw;
  if (!Number.isFinite(milliseconds)) throw tokenError(code);
  return Number(milliseconds);
}

function canonicalIso(value, code) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value) throw tokenError(code);
  return milliseconds;
}

function canonicalBase64url(value, maximumBytes, code) {
  if (typeof value !== 'string' || !value || value.length > MAX_TOKEN_BYTES
      || !/^[A-Za-z0-9_-]+$/.test(value)) throw tokenError(code);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > maximumBytes || bytes.toString('base64url') !== value) {
    throw tokenError(code);
  }
  return bytes;
}

function signingInput(payloadBytes) {
  return Buffer.concat([
    Buffer.from(ACTION_TOKEN_DOMAIN, 'utf8'),
    Buffer.from([0]),
    payloadBytes,
  ]);
}

function createQueryNotebookActionTokens(options) {
  allowedKeys(options, ['key', 'requesterAgent', 'now', 'randomBytes'],
    'action_token_configuration_invalid');
  if (!Object.hasOwn(options, 'key') || !Object.hasOwn(options, 'requesterAgent')) {
    throw tokenError('action_token_configuration_invalid');
  }
  let requesterAgent;
  try { requesterAgent = assertIdentifier(options.requesterAgent, 'requesterAgent'); } catch (error) {
    throw tokenError('action_token_configuration_invalid', error);
  }
  const key = Buffer.isBuffer(options.key)
    ? Buffer.from(options.key)
    : typeof options.key === 'string' ? Buffer.from(options.key, 'utf8') : null;
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  if (!key || key.length < 32 || key.length > 1024
      || typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw tokenError('action_token_configuration_invalid');
  }

  function signature(payloadBytes) {
    return crypto.createHmac('sha256', key).update(signingInput(payloadBytes)).digest();
  }

  function issue(input) {
    exactKeys(input, ['sourceOperationId', 'action', 'expiresAt'], 'invalid_request');
    try { assertOperationId(input.sourceOperationId); } catch (error) {
      throw tokenError('invalid_request', error);
    }
    if (!ACTIONS.has(input.action)) throw tokenError('invalid_request');
    const issuedMilliseconds = nowMs(now, 'action_token_unavailable');
    const expiresMilliseconds = canonicalIso(input.expiresAt, 'invalid_request');
    if (expiresMilliseconds <= issuedMilliseconds
        || expiresMilliseconds - issuedMilliseconds > MAX_TTL_MS) {
      throw tokenError('invalid_request');
    }
    const nonceBytes = randomBytes(24);
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 24) {
      throw tokenError('action_token_unavailable');
    }
    const claims = {
      v: 1,
      requesterAgent,
      sourceOperationId: input.sourceOperationId,
      action: input.action,
      issuedAt: new Date(issuedMilliseconds).toISOString(),
      expiresAt: input.expiresAt,
      nonce: nonceBytes.toString('base64url'),
    };
    const payloadBytes = Buffer.from(canonicalJson(claims), 'utf8');
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw tokenError('action_token_unavailable');
    return `${payloadBytes.toString('base64url')}.${signature(payloadBytes).toString('base64url')}`;
  }

  function verify(token, expected) {
    try {
      if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
        throw tokenError();
      }
      const parts = token.split('.');
      if (parts.length !== 2) throw tokenError();
      const payloadBytes = canonicalBase64url(parts[0], MAX_PAYLOAD_BYTES, 'action_token_invalid');
      const suppliedSignature = canonicalBase64url(parts[1], 32, 'action_token_invalid');
      const wantedSignature = signature(payloadBytes);
      const comparable = suppliedSignature.length === wantedSignature.length
        ? suppliedSignature : Buffer.alloc(wantedSignature.length);
      if (!crypto.timingSafeEqual(comparable, wantedSignature)
          || suppliedSignature.length !== wantedSignature.length) throw tokenError();
      exactKeys(expected, ['sourceOperationId', ...(Object.hasOwn(expected, 'action') ? ['action'] : [])],
        'action_token_invalid');
      assertOperationId(expected.sourceOperationId);
      if (expected.action !== undefined && !ACTIONS.has(expected.action)) throw tokenError();
      const claims = JSON.parse(payloadBytes.toString('utf8'));
      exactKeys(claims, CLAIM_FIELDS, 'action_token_invalid');
      if (Buffer.from(canonicalJson(claims), 'utf8').compare(payloadBytes) !== 0
          || claims.v !== 1
          || claims.requesterAgent !== requesterAgent
          || claims.sourceOperationId !== expected.sourceOperationId
          || !ACTIONS.has(claims.action)
          || (expected.action !== undefined && claims.action !== expected.action)
          || typeof claims.nonce !== 'string' || !NONCE_PATTERN.test(claims.nonce)) {
        throw tokenError();
      }
      const issuedMilliseconds = canonicalIso(claims.issuedAt, 'action_token_invalid');
      const expiresMilliseconds = canonicalIso(claims.expiresAt, 'action_token_invalid');
      const current = nowMs(now, 'action_token_invalid');
      if (issuedMilliseconds > current || expiresMilliseconds <= current
          || expiresMilliseconds <= issuedMilliseconds
          || expiresMilliseconds - issuedMilliseconds > MAX_TTL_MS) throw tokenError();
      return Object.freeze({ ...claims });
    } catch (error) {
      if (error?.code === 'action_token_invalid') throw error;
      throw tokenError('action_token_invalid', error);
    }
  }

  return Object.freeze({ issue, verify });
}

module.exports = {
  ACTION_TOKEN_DOMAIN,
  createQueryNotebookActionTokens,
};
