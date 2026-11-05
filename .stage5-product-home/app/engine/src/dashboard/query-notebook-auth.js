'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES,
} = require('../../../shared/query-notebook-credential.cjs');
const {
  assertIdentifier,
} = require('./brain-operations/operation-contract.js');

const DEVICE_AUDIENCE = QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES.device;
const WEB_SESSION_AUDIENCE = QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES.webSession;
const COOKIE_NAME = 'home23_query_session';
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_CREDENTIAL_BYTES = 4096;
const CREDENTIAL_ID_PATTERN = /^qncred_[A-Za-z0-9_-]{32}$/;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

function authError(code, httpStatus, retryable = false, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.httpStatus = httpStatus;
  error.retryable = retryable;
  return error;
}

function plainObject(value) {
  return value && !Array.isArray(value) && typeof value === 'object';
}

function nowMs(now) {
  const raw = now();
  const value = raw instanceof Date ? raw.getTime()
    : typeof raw === 'string' ? Date.parse(raw) : raw;
  if (!Number.isFinite(value)) throw authError('query_notebook_auth_unavailable', 503, true);
  return Number(value);
}

function parseBearer(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1] ?? null;
}

function parseBridgeBearer(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) {
    return null;
  }
  const match = /^Bearer ([^\s,]+)$/.exec(value);
  return match?.[1] ?? null;
}

function parseCookie(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES * 2) {
    return null;
  }
  let found = null;
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    if (found !== null) return null;
    const candidate = part.slice(index + 1).trim();
    if (!candidate || Buffer.byteLength(candidate, 'utf8') > MAX_CREDENTIAL_BYTES
        || !/^[A-Za-z0-9._~-]+$/.test(candidate)) return null;
    found = candidate;
  }
  return found;
}

function sendAuthError(res, error) {
  const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : 401;
  const code = typeof error?.code === 'string' ? error.code : 'query_notebook_unauthorized';
  return res.status(status).json({
    ok: false,
    error: { code, retryable: error?.retryable === true },
  });
}

function validateClaims(claims, expected, requesterAgent, current) {
  if (!plainObject(claims)
      || claims.v !== 1
      || claims.audience !== expected.audience
      || claims.requesterKind !== expected.requesterKind
      || claims.requesterAgent !== requesterAgent
      || typeof claims.credentialId !== 'string'
      || !Number.isSafeInteger(claims.generation) || claims.generation < 1
      || typeof claims.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(claims.expiresAt))
      || Date.parse(claims.expiresAt) <= current) {
    throw authError('query_notebook_unauthorized', 401);
  }
  if (!CREDENTIAL_ID_PATTERN.test(claims.credentialId)) {
    throw authError('query_notebook_unauthorized', 401);
  }
  return claims;
}

function createQueryNotebookAuth(options = {}) {
  if (!plainObject(options)) throw authError('query_notebook_auth_configuration_invalid', 500);
  let requesterAgent;
  try { requesterAgent = assertIdentifier(options.requesterAgent, 'requesterAgent'); } catch (error) {
    throw authError('query_notebook_auth_configuration_invalid', 500, false, error);
  }
  const authority = options.credentialAuthority;
  const lookupDeviceCredential = options.lookupDeviceCredential;
  const verifyBridgeBearer = options.verifyBridgeBearer;
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const cookieName = options.cookieName ?? COOKIE_NAME;
  if (typeof now !== 'function' || typeof randomBytes !== 'function'
      || typeof cookieName !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(cookieName)) {
    throw authError('query_notebook_auth_configuration_invalid', 500);
  }

  function configured() {
    return authority && typeof authority.issue === 'function' && typeof authority.verify === 'function';
  }

  async function authenticate(req) {
    if (!configured()) throw authError('query_notebook_auth_unavailable', 503, true);
    const current = nowMs(now);
    const authorization = req.get('authorization');
    if (authorization !== undefined) {
      const token = parseBearer(authorization);
      const deviceId = req.get('x-home23-device-id');
      if (!token || typeof deviceId !== 'string') {
        throw authError('query_notebook_unauthorized', 401);
      }
      let claims;
      try {
        claims = authority.verify(token, {
          audience: DEVICE_AUDIENCE,
          credentialId: deviceId,
          requesterKind: 'device',
        });
      } catch (error) {
        throw authError('query_notebook_unauthorized', 401, false, error);
      }
      validateClaims(claims, { audience: DEVICE_AUDIENCE, requesterKind: 'device' },
        requesterAgent, current);
      if (claims.credentialId !== deviceId || typeof lookupDeviceCredential !== 'function') {
        if (typeof lookupDeviceCredential !== 'function') {
          throw authError('query_notebook_auth_unavailable', 503, true);
        }
        throw authError('query_notebook_unauthorized', 401);
      }
      const durable = await lookupDeviceCredential(claims.credentialId);
      if (!plainObject(durable)
          || typeof durable.installation_id !== 'string'
          || !INSTALLATION_ID_PATTERN.test(durable.installation_id)
          || durable.credential_id !== claims.credentialId
          || durable.credential_generation !== claims.generation
          || durable.revoked_at !== null
          || durable.requester_agent !== requesterAgent) {
        throw authError('query_notebook_unauthorized', 401);
      }
      return Object.freeze({
        requesterAgent,
        credentialId: claims.credentialId,
        deviceId: durable.installation_id,
        requesterKind: 'device',
        generation: claims.generation,
        credentialExpiresAt: claims.expiresAt,
      });
    }

    const token = parseCookie(req.get('cookie'), cookieName);
    if (!token) throw authError('query_notebook_unauthorized', 401);
    let claims;
    try {
      claims = authority.verify(token, {
        audience: WEB_SESSION_AUDIENCE,
        requesterKind: 'web-session',
      });
    } catch (error) {
      throw authError('query_notebook_unauthorized', 401, false, error);
    }
    validateClaims(claims, {
      audience: WEB_SESSION_AUDIENCE,
      requesterKind: 'web-session',
    }, requesterAgent, current);
    return Object.freeze({
      requesterAgent,
      credentialId: claims.credentialId,
      requesterKind: 'web-session',
      generation: claims.generation,
      credentialExpiresAt: claims.expiresAt,
    });
  }

  async function requireCredential(req, res, next) {
    try {
      req.queryNotebookIdentity = await authenticate(req);
      next();
    } catch (error) {
      sendAuthError(res, error);
    }
  }

  async function createSession(req, res) {
    try {
      if (!configured() || typeof verifyBridgeBearer !== 'function') {
        throw authError('query_notebook_auth_unavailable', 503, true);
      }
      const forwardedProtocol = req.get('x-forwarded-proto');
      const protocol = forwardedProtocol === 'https' ? 'https' : req.protocol;
      const origin = `${protocol}://${req.get('host')}`;
      if (req.get('origin') !== origin
          || req.get('sec-fetch-site') !== 'same-origin'
          || req.get('sec-fetch-mode') !== 'cors'
          || req.get('sec-fetch-dest') !== 'empty') {
        throw authError('query_notebook_same_origin_required', 403);
      }
      const token = parseBridgeBearer(req.get('authorization'));
      if (!token || await verifyBridgeBearer(token, { requesterAgent }) !== true) {
        throw authError('query_notebook_unauthorized', 401);
      }
      const issuedAt = nowMs(now);
      const expiresAt = new Date(issuedAt + SESSION_TTL_MS).toISOString();
      const nonce = randomBytes(24);
      if (!Buffer.isBuffer(nonce) || nonce.length !== 24) {
        throw authError('query_notebook_auth_unavailable', 503, true);
      }
      const credentialId = `qncred_${nonce.toString('base64url')}`;
      const sessionToken = authority.issue({
        audience: WEB_SESSION_AUDIENCE,
        credentialId,
        requesterKind: 'web-session',
        generation: 1,
        expiresAt,
      });
      if (typeof sessionToken !== 'string' || !sessionToken
          || Buffer.byteLength(sessionToken, 'utf8') > MAX_CREDENTIAL_BYTES) {
        throw authError('query_notebook_auth_unavailable', 503, true);
      }
      const secure = req.secure || req.get('x-forwarded-proto') === 'https';
      res.setHeader('set-cookie', [
        `${cookieName}=${sessionToken}`,
        'Path=/home23/api/query',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ...(secure ? ['Secure'] : []),
      ].join('; '));
      res.status(200).json({ schemaVersion: 1, expiresAt });
    } catch (error) {
      sendAuthError(res, error);
    }
  }

  return Object.freeze({ authenticate, createSession, requireCredential });
}

function createQueryNotebookCredentialLookup(options = {}) {
  if (!plainObject(options)
      || typeof options.filePath !== 'string'
      || !path.isAbsolute(options.filePath)
      || path.normalize(options.filePath) !== options.filePath
      || options.filePath.includes('\0')) {
    throw authError('query_notebook_auth_configuration_invalid', 500);
  }
  let requesterAgent;
  try { requesterAgent = assertIdentifier(options.requesterAgent, 'requesterAgent'); } catch (error) {
    throw authError('query_notebook_auth_configuration_invalid', 500, false, error);
  }
  return async (credentialId) => {
    if (typeof credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialId)) return null;
    try {
      const stat = await fs.promises.lstat(options.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
        throw authError('query_notebook_auth_unavailable', 503, true);
      }
      const parsed = JSON.parse(await fs.promises.readFile(options.filePath, 'utf8'));
      if (!plainObject(parsed) || parsed.version !== 2
          || !Array.isArray(parsed.query_credentials)) {
        throw authError('query_notebook_auth_unavailable', 503, true);
      }
      const matches = parsed.query_credentials.filter((entry) => plainObject(entry)
        && entry.credential_id === credentialId && entry.requester_agent === requesterAgent);
      if (matches.length !== 1) return null;
      const match = matches[0];
      if (!Number.isSafeInteger(match.credential_generation)
          || match.credential_generation < 1
          || (match.revoked_at !== null && typeof match.revoked_at !== 'string')) {
        throw authError('query_notebook_auth_unavailable', 503, true);
      }
      return { ...match };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'query_notebook_auth_unavailable') throw error;
      throw authError('query_notebook_auth_unavailable', 503, true, error);
    }
  };
}

module.exports = {
  COOKIE_NAME,
  DEVICE_AUDIENCE,
  WEB_SESSION_AUDIENCE,
  createQueryNotebookAuth,
  createQueryNotebookCredentialLookup,
};
