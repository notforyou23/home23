'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const {
  createMcpMemoryToolsCache,
  mcpIdentityJsonRpcError,
  resolveMcpRequestAgent,
  validateResidentAgent,
} = require('../../cosmo23/engine/mcp/http-server.js');
const {
  issueMcpRequestIdentity,
  mcpRequestBodyDigest,
} = require('../../shared/mcp-request-identity.cjs');

const REQUEST_IDENTITY_KEY = '8'.repeat(64);
const NOW = 1_800_000_000_000;

async function home23Fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-mcp-identity-')));
  await Promise.all([
    fsp.mkdir(path.join(root, 'instances', 'jerry'), { recursive: true }),
    fsp.mkdir(path.join(root, 'instances', 'forrest'), { recursive: true }),
  ]);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function requestBody(id) {
  return { jsonrpc: '2.0', id, method: 'tools/list' };
}

function authorization(agent, body, nonce) {
  return `Bearer ${issueMcpRequestIdentity(REQUEST_IDENTITY_KEY, {
    agent,
    audience: 'cosmo23-mcp',
    method: 'POST',
    path: '/mcp',
    bodyDigest: mcpRequestBodyDigest(body),
    issuedAt: NOW,
    expiresAt: NOW + 30_000,
    nonce,
  })}`;
}

test('valid MCP request identity resolves the signed resident agent', async (t) => {
  const home23Root = await home23Fixture(t);
  const body = requestBody('valid-jerry');

  const resolved = resolveMcpRequestAgent({
    authorization: authorization('jerry', body, 'valid-jerry-request-nonce'),
    requestIdentityKey: REQUEST_IDENTITY_KEY,
    home23Root,
    fallbackAgent: null,
    method: 'POST',
    path: '/mcp',
    body,
    now: NOW + 1_000,
  });

  assert.deepEqual(resolved, { agent: 'jerry', source: 'token' });
});

test('two signed resident agents receive isolated memory-tool targets in one cache', async (t) => {
  const home23Root = await home23Fixture(t);
  const creations = [];
  const cache = createMcpMemoryToolsCache({
    maxEntries: 4,
    createMemoryTools(agent) {
      const tools = { requesterAgent: agent, target: `resident-${agent}` };
      creations.push(tools);
      return tools;
    },
  });
  const agents = ['jerry', 'forrest'].map((agent) => {
    const body = requestBody(`isolation-${agent}`);
    return resolveMcpRequestAgent({
      authorization: authorization(agent, body, `isolation-${agent}-nonce`),
      requestIdentityKey: REQUEST_IDENTITY_KEY,
      home23Root,
      fallbackAgent: null,
      method: 'POST',
      path: '/mcp',
      body,
      now: NOW + 1_000,
    }).agent;
  });

  const jerryTools = cache.get(agents[0]);
  const forrestTools = cache.get(agents[1]);

  assert.notEqual(jerryTools, forrestTools);
  assert.deepEqual(jerryTools, { requesterAgent: 'jerry', target: 'resident-jerry' });
  assert.deepEqual(forrestTools, { requesterAgent: 'forrest', target: 'resident-forrest' });
  assert.equal(cache.get('jerry'), jerryTools);
  assert.equal(creations.length, 2);
});

test('forged MCP identity is rejected without falling through to a valid env fallback', async (t) => {
  const home23Root = await home23Fixture(t);
  const body = requestBody('forged');
  const valid = authorization('forrest', body, 'forged-request-check-nonce');
  const forged = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;

  assert.throws(
    () => resolveMcpRequestAgent({
      authorization: forged,
      requestIdentityKey: REQUEST_IDENTITY_KEY,
      home23Root,
      fallbackAgent: 'jerry',
      method: 'POST',
      path: '/mcp',
      body,
      now: NOW + 1_000,
    }),
    (error) => error.code === 'mcp_request_identity_invalid',
  );
});

test('resident validation rejects traversal, invalid names, and nonexistent agents', async (t) => {
  const home23Root = await home23Fixture(t);

  for (const agent of ['../jerry', '..', '/tmp/jerry', 'missing']) {
    assert.throws(
      () => validateResidentAgent(home23Root, agent),
      (error) => error.code === 'mcp_request_identity_agent_invalid',
      agent,
    );
  }
  assert.equal(validateResidentAgent(home23Root, 'forrest'), 'forrest');
});

test('only absent authorization may resolve through a validated fallback agent', async (t) => {
  const home23Root = await home23Fixture(t);
  const resolved = resolveMcpRequestAgent({
    authorization: undefined,
    requestIdentityKey: null,
    home23Root,
    fallbackAgent: 'jerry',
    method: 'POST',
    path: '/mcp',
    body: requestBody('fallback'),
    now: NOW,
  });

  assert.deepEqual(resolved, { agent: 'jerry', source: 'fallback' });
});

test('unresolvable identity becomes a typed JSON-RPC error envelope', async (t) => {
  const home23Root = await home23Fixture(t);
  let caught;
  try {
    resolveMcpRequestAgent({
      authorization: undefined,
      requestIdentityKey: null,
      home23Root,
      fallbackAgent: null,
      method: 'POST',
      path: '/mcp',
      body: requestBody('unresolved'),
      now: NOW,
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.code, 'mcp_request_identity_required');
  assert.deepEqual(mcpIdentityJsonRpcError(caught, 'unresolved'), {
    status: 401,
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'MCP request identity required',
        data: { code: 'mcp_request_identity_required' },
      },
      id: 'unresolved',
    },
  });
});

test('memory-tool cache evicts its oldest agent entry at the configured bound', () => {
  let creations = 0;
  const cache = createMcpMemoryToolsCache({
    maxEntries: 2,
    createMemoryTools(agent) {
      creations += 1;
      return { agent, creation: creations };
    },
  });

  const firstJerry = cache.get('jerry');
  cache.get('forrest');
  cache.get('ada');
  const nextJerry = cache.get('jerry');

  assert.notEqual(firstJerry, nextJerry);
  assert.equal(cache.size(), 2);
  assert.equal(creations, 4);
});
