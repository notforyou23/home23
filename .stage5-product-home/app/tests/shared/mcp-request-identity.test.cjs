'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');

const {
  MCP_REQUEST_IDENTITY_MAX_TTL_MS,
  MCP_REQUEST_IDENTITY_SCHEMA,
  issueMcpRequestIdentity,
  mcpRequestBodyDigest,
  verifyMcpRequestIdentity,
} = require('../../shared/mcp-request-identity.cjs');

const ROOT_KEY = '4'.repeat(64);
const NOW = 1_800_000_000_000;
const BODY = { jsonrpc: '2.0', id: 7, method: 'tools/list' };
const BODY_DIGEST = `sha256:${createHash('sha256')
  .update('{"id":7,"jsonrpc":"2.0","method":"tools/list"}')
  .digest('hex')}`;

function claims(overrides = {}) {
  return {
    agent: 'jerry',
    audience: 'cosmo23-mcp',
    method: 'POST',
    path: '/mcp',
    bodyDigest: BODY_DIGEST,
    issuedAt: NOW,
    expiresAt: NOW + 30_000,
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    audience: 'cosmo23-mcp',
    method: 'POST',
    path: '/mcp',
    bodyDigest: BODY_DIGEST,
    now: NOW + 1_000,
    ...overrides,
  };
}

test('MCP request identity signs a domain-separated canonical request contract', () => {
  assert.equal(mcpRequestBodyDigest({ method: 'tools/list', id: 7, jsonrpc: '2.0' }), BODY_DIGEST);

  const token = issueMcpRequestIdentity(ROOT_KEY, claims({ nonce: 'canonical-contract-nonce' }));
  const [payloadPart, signaturePart] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  const rawParentSignature = createHmac('sha256', ROOT_KEY).update(payloadPart).digest('base64url');

  assert.equal(payload.schema, MCP_REQUEST_IDENTITY_SCHEMA);
  assert.equal(payload.v, 1);
  assert.equal(payload.agent, 'jerry');
  assert.equal(payload.bodyDigest, BODY_DIGEST);
  assert.notEqual(signaturePart, rawParentSignature, 'the parent privileged key must not sign directly');
  assert.equal(verifyMcpRequestIdentity(ROOT_KEY, token, expected()).agent, 'jerry');
});

test('MCP request identity rejects forged signatures without consuming the valid nonce', () => {
  const token = issueMcpRequestIdentity(ROOT_KEY, claims({ nonce: 'forgery-check-nonce' }));
  const [payload] = token.split('.');
  const forged = `${payload}.${Buffer.alloc(32, 9).toString('base64url')}`;

  assert.throws(
    () => verifyMcpRequestIdentity(ROOT_KEY, forged, expected()),
    (error) => error.code === 'mcp_request_identity_invalid',
  );
  assert.equal(verifyMcpRequestIdentity(ROOT_KEY, token, expected()).agent, 'jerry');
});

test('MCP request identity rejects expired and overlong credentials', () => {
  const expired = issueMcpRequestIdentity(ROOT_KEY, claims({
    nonce: 'expired-token-nonce',
    issuedAt: NOW - 40_000,
    expiresAt: NOW - 10_000,
  }));
  assert.throws(
    () => verifyMcpRequestIdentity(ROOT_KEY, expired, expected()),
    (error) => error.code === 'mcp_request_identity_expired',
  );
  assert.throws(
    () => issueMcpRequestIdentity(ROOT_KEY, claims({
      nonce: 'overlong-token-nonce',
      expiresAt: NOW + MCP_REQUEST_IDENTITY_MAX_TTL_MS + 1,
    })),
    (error) => error.code === 'mcp_request_identity_expired',
  );
});

test('MCP request identity rejects a replayed nonce', () => {
  const token = issueMcpRequestIdentity(ROOT_KEY, claims({ nonce: 'replay-check-nonce' }));
  assert.equal(verifyMcpRequestIdentity(ROOT_KEY, token, expected()).agent, 'jerry');
  assert.throws(
    () => verifyMcpRequestIdentity(ROOT_KEY, token, expected({ now: NOW + 2_000 })),
    (error) => error.code === 'mcp_request_identity_replayed',
  );
});

test('MCP request identity rejects body, method, path, audience, and optional-agent mismatches', () => {
  const mismatchCases = [
    { label: 'body', expected: { bodyDigest: `sha256:${'0'.repeat(64)}` } },
    { label: 'method', expected: { method: 'GET' } },
    { label: 'path', expected: { path: '/other' } },
    { label: 'audience', expected: { audience: 'other-service' } },
    { label: 'agent', expected: { agent: 'forrest' } },
  ];

  for (const item of mismatchCases) {
    const token = issueMcpRequestIdentity(ROOT_KEY, claims({
      nonce: `mismatch-${item.label}-nonce`,
    }));
    assert.throws(
      () => verifyMcpRequestIdentity(ROOT_KEY, token, expected(item.expected)),
      (error) => error.code === 'mcp_request_identity_mismatch',
      item.label,
    );
  }
});

test('MCP request identity rejects malformed agents, digests, nonces, and extra claims', () => {
  const invalidCases = [
    claims({ agent: '../jerry', nonce: 'invalid-agent-nonce' }),
    claims({ bodyDigest: 'sha256:not-a-digest', nonce: 'invalid-digest-nonce' }),
    claims({ nonce: 'spaces are invalid' }),
    { ...claims({ nonce: 'extra-claim-nonce' }), privilege: 'admin' },
  ];

  for (const invalid of invalidCases) {
    assert.throws(
      () => issueMcpRequestIdentity(ROOT_KEY, invalid),
      (error) => error.code === 'mcp_request_identity_invalid',
    );
  }
});
