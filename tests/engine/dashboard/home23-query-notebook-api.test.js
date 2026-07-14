import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');

const NOW = Date.parse('2026-07-13T20:00:00.000Z');
const OPERATION_ID = `brop_${'A'.repeat(32)}`;
const CREDENTIAL_ID = `qncred_${'D'.repeat(32)}`;
const DEVICE_INSTALLATION_ID = 'install_0123456789abcdef01234567';
const CHILD_OPERATION_ID = `brop_${'B'.repeat(32)}`;

function notebookSummary(overrides = {}) {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    requestKind: 'pgs',
    requesterAgent: 'jerry',
    brain: { id: 'brain-jerry', displayName: 'Jerry' },
    question: 'Map durable truth',
    questionTitle: 'Map durable truth',
    configuration: {
      pgsMode: 'fresh', pgsLevel: 'sample',
      sweepModel: { provider: 'minimax', model: 'sweep' },
      synthesisModel: { provider: 'anthropic', model: 'synth' },
    },
    executionState: 'partial',
    humanClassification: 'finished',
    acceptedAt: '2026-07-13T19:00:00.000Z',
    startedAt: '2026-07-13T19:00:01.000Z',
    updatedAt: '2026-07-13T19:10:00.000Z',
    completedAt: '2026-07-13T19:10:00.000Z',
    progress: { version: 1, stage: 'terminal', eventSequence: 5 },
    error: { code: 'pgs_scope_incomplete', retryable: true },
    resultAvailability: 'available',
    expiresAt: '2026-07-20T19:10:00.000Z',
    answerPreviewAvailable: true,
    resultVersion: `qrv1_${'V'.repeat(43)}`,
    coverage: {
      coverageLevel: 'sample', scopePendingWorkUnits: 1, scopeComplete: false,
    },
    continuation: {
      canContinue: true, continuableUntil: '2026-07-20T19:10:00.000Z',
      sourceOperationId: null,
    },
    actions: [{
      kind: 'continueSweep', token: 'opaque-action-token',
      expiresAt: '2026-07-13T20:30:00.000Z',
    }],
    ...overrides,
  };
}

function durableNotebookRecord() {
  return {
    operationId: OPERATION_ID,
    requestId: 'query-notebook-status',
    operationType: 'pgs',
    requesterAgent: 'jerry',
    requestParameters: {
      query: 'Map durable truth', pgsMode: 'fresh', pgsLevel: 'sample',
    },
    parameters: {
      query: 'Map durable truth', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'sweep' },
      pgsSynth: { provider: 'anthropic', model: 'synth' },
    },
    acceptedAt: '2026-07-13T19:00:00.000Z',
    target: {
      domain: 'brain', brainId: 'brain-jerry', displayName: 'Jerry',
      canonicalRoot: '/private/brain', ownerAgent: 'jerry',
    },
    state: 'partial',
    startedAt: '2026-07-13T19:00:01.000Z',
    updatedAt: '2026-07-13T19:10:00.000Z',
    completedAt: '2026-07-13T19:10:00.000Z',
    progressSnapshot: { version: 1, stage: 'terminal', eventSequence: 5 },
    error: { code: 'pgs_scope_incomplete', retryable: true },
    pgsSession: {
      sessionId: `pgss_${'S'.repeat(32)}`,
      continuableUntil: '2026-07-20T19:10:00.000Z', sourceOperationId: null,
    },
    result: null,
    resultHandle: `brres_${'H'.repeat(32)}`,
    resultArtifact: {
      mediaType: 'application/json', contentEncoding: 'identity',
      bytes: 1, sha256: '0'.repeat(64),
    },
    resultExpiresAt: '2026-07-20T19:10:00.000Z',
    resultExpiredAt: null,
    notebookResultSummary: {
      version: 1, resultVersion: `qrv1_${'V'.repeat(43)}`, answerAvailable: true,
      coverage: {
        coverageLevel: 'sample', scopePendingWorkUnits: 1, scopeComplete: false,
        retryablePartitions: ['c-retry-1'], retryablePartitionCount: 1,
      },
      continuation: {
        canContinue: true, continuableUntil: '2026-07-20T19:10:00.000Z',
        sourceOperationId: null,
      },
    },
    sourcePinDescriptor: {
      version: 1, canonicalRoot: '/private/brain', cutoffRevision: 42,
    },
    sourcePinDigest: `sha256:${'a'.repeat(64)}`,
    sourceEvidence: null,
  };
}

function acceptedAuth() {
  return {
    requireCredential(req, _res, next) {
      const requesterKind = req.get('x-test-web') === '1' ? 'web-session' : 'device';
      req.queryNotebookIdentity = {
        requesterAgent: 'jerry',
        credentialId: CREDENTIAL_ID,
        ...(requesterKind === 'device' ? { deviceId: DEVICE_INSTALLATION_ID } : {}),
        requesterKind,
        generation: 2,
        credentialExpiresAt: '2026-07-14T20:00:00.000Z',
      };
      next();
    },
    createSession(_req, res) { res.json({ schemaVersion: 1 }); },
  };
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

function claims(overrides = {}) {
  return {
    v: 1,
    audience: 'device',
    requesterAgent: 'jerry',
    credentialId: CREDENTIAL_ID,
    requesterKind: 'device',
    generation: 2,
    issuedAt: '2026-07-13T19:55:00.000Z',
    expiresAt: '2026-07-14T20:00:00.000Z',
    ...overrides,
  };
}

function fakeCredentialAuthority(tokenClaims = new Map()) {
  return {
    issue(input) {
      return { token: `issued-${input.credentialId}`, claims: claims(input) };
    },
    verify(token, expected) {
      const value = tokenClaims.get(token);
      if (!value || value.audience !== expected.audience
          || (expected.requesterKind !== undefined
            && value.requesterKind !== expected.requesterKind)) {
        const error = new Error('credential_invalid');
        error.code = 'credential_invalid';
        throw error;
      }
      return value;
    },
  };
}

test('protected Query notebook modules publish their construction seams', () => {
  let api;
  let auth;
  let subscriptions;
  try { api = require('../../../engine/src/dashboard/home23-query-notebook-api.js'); } catch {}
  try { auth = require('../../../engine/src/dashboard/query-notebook-auth.js'); } catch {}
  try { subscriptions = require('../../../engine/src/dashboard/query-notebook-subscriptions.js'); } catch {}
  assert.equal(typeof api?.createQueryNotebookPlaceholderRouter, 'function');
  assert.equal(typeof api?.createHome23QueryNotebookRouter, 'function');
  assert.equal(typeof auth?.createQueryNotebookAuth, 'function');
  assert.equal(typeof subscriptions?.createQueryNotebookSubscriptions, 'function');
});

test('Task4 service exposes one requester-bound status with executable action authority', async () => {
  const { createQueryNotebookService } = require(
    '../../../engine/src/dashboard/query-notebook-service.js'
  );
  const { createQueryNotebookActionTokens } = require(
    '../../../engine/src/dashboard/query-notebook-action-token.js'
  );
  const record = durableNotebookRecord();
  const actionTokens = createQueryNotebookActionTokens({
    key: Buffer.alloc(32, 4), requesterAgent: 'jerry', now: () => NOW,
    randomBytes: () => Buffer.alloc(24, 3),
  });
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return [record]; },
      async getAuthorized() { return record; },
      async getResultAuthorized() { return {}; },
    },
    now: () => NOW,
    actionTokens,
    startOperation: async () => {},
  });
  assert.equal(typeof service.getQueryNotebookStatusAuthorized, 'function');
  const status = await service.getQueryNotebookStatusAuthorized(OPERATION_ID);
  assert.equal(status.operationId, OPERATION_ID);
  assert.equal(status.requesterAgent, 'jerry');
  assert.deepEqual(status.actions.map(({ kind }) => kind), ['continueSweep', 'targetedRetry']);
  assert.equal(JSON.stringify(status).includes('resultHandle'), false);
});

test('notebook authentication fails closed when credential authority is unavailable', async (t) => {
  const { createQueryNotebookAuth } = require('../../../engine/src/dashboard/query-notebook-auth.js');
  const auth = createQueryNotebookAuth({ requesterAgent: 'jerry' });
  const app = express();
  app.get('/protected', auth.requireCredential, (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  t.after(server.close);
  const response = await fetch(`${server.base}/protected`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'query_notebook_auth_unavailable', retryable: true },
  });
});

test('device bearer requires exact audience, agent, device ID, and current generation', async (t) => {
  const { createQueryNotebookAuth } = require('../../../engine/src/dashboard/query-notebook-auth.js');
  const authority = fakeCredentialAuthority(new Map([
    ['valid-device', claims()],
    ['wrong-agent', claims({ requesterAgent: 'forrest' })],
    ['bridge-token', claims({ audience: 'bridge' })],
    ['expired-device', claims({ expiresAt: '2026-07-13T19:59:59.000Z' })],
  ]));
  let generation = 2;
  let revokedAt = null;
  let installationId = DEVICE_INSTALLATION_ID;
  const auth = createQueryNotebookAuth({
    requesterAgent: 'jerry',
    credentialAuthority: authority,
    lookupDeviceCredential: async (credentialId) => ({
      installation_id: installationId,
      credential_id: credentialId,
      credential_generation: generation,
      requester_agent: 'jerry',
      revoked_at: revokedAt,
    }),
    now: () => NOW,
  });
  const app = express();
  app.get('/protected', auth.requireCredential, (req, res) => {
    res.json({ identity: req.queryNotebookIdentity });
  });
  app.post(`/home23/api/query/operations/${OPERATION_ID}/export`, express.json(),
    auth.requireCredential, (req, res) => res.json({ accepted: req.body.format }));
  const server = await listen(app);
  t.after(server.close);
  const get = (token, deviceId = CREDENTIAL_ID) => fetch(`${server.base}/protected`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { 'x-home23-device-id': deviceId } : {}),
    },
  });

  for (const response of [
    await get(null),
    await get('bridge-token'),
    await get('wrong-agent'),
    await get('expired-device'),
    await get('valid-device', `qncred_${'X'.repeat(32)}`),
  ]) assert.equal(response.status, 401);

  const wrongDeviceExport = await fetch(
    `${server.base}/home23/api/query/operations/${OPERATION_ID}/export`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-device',
        'x-home23-device-id': `qncred_${'X'.repeat(32)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ format: 'markdown' }),
    },
  );
  assert.equal(wrongDeviceExport.status, 401);

  generation = 3;
  assert.equal((await get('valid-device')).status, 401);
  generation = 2;
  revokedAt = '2026-07-13T19:59:00.000Z';
  assert.equal((await get('valid-device')).status, 401);
  revokedAt = null;
  const accepted = await get('valid-device');
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).identity, {
    requesterAgent: 'jerry', credentialId: CREDENTIAL_ID,
    deviceId: DEVICE_INSTALLATION_ID, requesterKind: 'device', generation: 2,
    credentialExpiresAt: '2026-07-14T20:00:00.000Z',
  });
  installationId = undefined;
  assert.equal((await get('valid-device')).status, 401);
  installationId = 'malformed';
  assert.equal((await get('valid-device')).status, 401);
});

test('same-origin bridge exchange issues only an HttpOnly scoped web session', async (t) => {
  const { createQueryNotebookAuth } = require('../../../engine/src/dashboard/query-notebook-auth.js');
  const issued = [];
  const authority = fakeCredentialAuthority(new Map());
  authority.issue = (input) => {
    issued.push(input);
    return `session-${input.credentialId}`;
  };
  authority.verify = (token, expected) => {
    if (!token.startsWith('session-qncred_') || expected.audience !== 'web-session') {
      const error = new Error('credential_invalid');
      error.code = 'credential_invalid';
      throw error;
    }
    return claims({
      audience: 'web-session', credentialId: token.slice('session-'.length),
      requesterKind: 'web-session', generation: 1,
      expiresAt: '2026-07-13T20:15:00.000Z',
    });
  };
  const auth = createQueryNotebookAuth({
    requesterAgent: 'jerry', credentialAuthority: authority,
    verifyBridgeBearer: async (token) => token === 'bridge-secret',
    now: () => NOW,
    randomBytes: () => Buffer.alloc(24, 7),
  });
  const app = express();
  app.post('/home23/api/query/session', auth.createSession);
  app.get('/home23/api/query/protected', auth.requireCredential,
    (req, res) => res.json(req.queryNotebookIdentity));
  const server = await listen(app);
  t.after(server.close);

  const exchange = (headers = {}) => fetch(`${server.base}/home23/api/query/session`, {
    method: 'POST', headers,
  });
  assert.equal((await exchange({ authorization: 'Bearer bridge-secret' })).status, 403);
  const accepted = await exchange({
    authorization: 'Bearer bridge-secret',
    origin: server.base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    schemaVersion: 1, expiresAt: '2026-07-13T20:15:00.000Z',
  });
  assert.equal(issued.length, 1);
  assert.equal(issued[0].audience, 'web-session');
  const cookie = accepted.headers.get('set-cookie');
  assert.match(cookie, /^home23_query_session=session-qncred_/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/home23\/api\/query/i);
  const protectedResponse = await fetch(`${server.base}/home23/api/query/protected`, {
    headers: { cookie: cookie.split(';')[0] },
  });
  assert.equal(protectedResponse.status, 200);
  assert.equal((await protectedResponse.json()).requesterKind, 'web-session');
});

test('web session exchange interoperates with the shared credential authority', async (t) => {
  const { createQueryNotebookAuth } = require('../../../engine/src/dashboard/query-notebook-auth.js');
  const { createQueryNotebookCredentialAuthority } = require(
    '../../../shared/query-notebook-credential.cjs'
  );
  const authority = createQueryNotebookCredentialAuthority({
    bridgeToken: 'b'.repeat(64), requesterAgent: 'jerry', now: () => NOW,
  });
  const auth = createQueryNotebookAuth({
    requesterAgent: 'jerry', credentialAuthority: authority,
    verifyBridgeBearer: async (token) => token === 'b'.repeat(64),
    now: () => NOW,
    randomBytes: () => Buffer.alloc(24, 9),
  });
  const app = express();
  app.post('/home23/api/query/session', auth.createSession);
  app.get('/home23/api/query/protected', auth.requireCredential,
    (req, res) => res.json(req.queryNotebookIdentity));
  const server = await listen(app);
  t.after(server.close);
  const accepted = await fetch(`${server.base}/home23/api/query/session`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'b'.repeat(64)}`,
      origin: server.base.replace('http:', 'https:'),
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
  });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('set-cookie'), /; Secure/);
  const cookie = accepted.headers.get('set-cookie').split(';')[0];
  const protectedResponse = await fetch(`${server.base}/home23/api/query/protected`, {
    headers: { cookie },
  });
  assert.equal(protectedResponse.status, 200);
  const identity = await protectedResponse.json();
  assert.match(identity.credentialId, /^qncred_[A-Za-z0-9_-]{32}$/);
  assert.equal(identity.requesterKind, 'web-session');
});

test('read-only device lookup enforces current durable generation and revocation', async (t) => {
  const {
    createQueryNotebookAuth,
    createQueryNotebookCredentialLookup,
  } = require('../../../engine/src/dashboard/query-notebook-auth.js');
  const { createQueryNotebookCredentialAuthority } = require(
    '../../../shared/query-notebook-credential.cjs'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-auth-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'device-registry.json');
  const enrollment = {
    installation_id: 'installation-0001',
    requester_agent: 'jerry',
    credential_id: CREDENTIAL_ID,
    credential_generation: 1,
    enrolled_at: '2026-07-13T19:00:00.000Z',
    updated_at: '2026-07-13T19:00:00.000Z',
    revoked_at: null,
  };
  const writeRegistry = () => fs.writeFileSync(filePath, JSON.stringify({
    version: 2, devices: [], query_credentials: [enrollment],
  }));
  writeRegistry();
  const authority = createQueryNotebookCredentialAuthority({
    bridgeToken: 'd'.repeat(64), requesterAgent: 'jerry', now: () => NOW,
  });
  const token = authority.issue({
    audience: 'device', credentialId: CREDENTIAL_ID, requesterKind: 'device',
    generation: 1, expiresAt: '2026-07-14T20:00:00.000Z',
  });
  const auth = createQueryNotebookAuth({
    requesterAgent: 'jerry', credentialAuthority: authority,
    lookupDeviceCredential: createQueryNotebookCredentialLookup({ filePath, requesterAgent: 'jerry' }),
    now: () => NOW,
  });
  const app = express();
  app.get('/protected', auth.requireCredential, (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  t.after(server.close);
  const request = () => fetch(`${server.base}/protected`, { headers: {
    authorization: `Bearer ${token}`, 'x-home23-device-id': CREDENTIAL_ID,
  } });
  assert.equal((await request()).status, 200);
  enrollment.credential_generation = 2;
  writeRegistry();
  assert.equal((await request()).status, 401);
  enrollment.credential_generation = 1;
  enrollment.revoked_at = '2026-07-13T19:30:00.000Z';
  writeRegistry();
  assert.equal((await request()).status, 401);
});

test('subscription registry persists one bounded stable terminal route atomically', async (t) => {
  const { createQueryNotebookSubscriptions } = require(
    '../../../engine/src/dashboard/query-notebook-subscriptions.js'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-subscriptions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'query-notebook-subscriptions.json');
  let now = NOW;
  const makeStore = () => createQueryNotebookSubscriptions({
    filePath, requesterAgent: 'jerry', now: () => now, maxEntries: 2,
  });
  const store = makeStore();
  const input = {
    requesterAgent: 'jerry', operationId: OPERATION_ID,
    credentialId: 'device-1', deviceId: 'device-1', generation: 2,
    expiresAt: '2026-07-14T20:00:00.000Z', terminalState: null,
  };
  const subscribed = await store.subscribe(input);
  assert.equal(subscribed.deliveryState, 'active');
  assert.equal((await store.subscribe(input)).routeId, subscribed.routeId);
  assert.equal((await store.listActive({ operationId: OPERATION_ID })).length, 1);

  const pending = await store.markTerminalPending({
    requesterAgent: 'jerry', operationId: OPERATION_ID, terminalState: 'partial',
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].routeId, subscribed.routeId);
  assert.equal(pending[0].deliveryState, 'pending');
  assert.equal(pending[0].terminalState, 'partial');

  const reopened = makeStore();
  const beforeRead = fs.statSync(filePath, { bigint: true });
  assert.equal((await reopened.listActive({ operationId: OPERATION_ID }))[0].deliveryState,
    'pending');
  const afterRead = fs.statSync(filePath, { bigint: true });
  assert.equal(afterRead.ino, beforeRead.ino, 'read without cleanup must not replace file');
  assert.equal(afterRead.mtimeNs, beforeRead.mtimeNs, 'read without cleanup must not write file');
  const delivered = await reopened.markDelivered({ routeId: subscribed.routeId });
  assert.equal(delivered.deliveryState, 'delivered');
  assert.equal(await reopened.unsubscribe({
    requesterAgent: 'jerry', operationId: OPERATION_ID, credentialId: 'device-1',
  }), true);
  assert.deepEqual(await reopened.listActive({ operationId: OPERATION_ID }), []);

  await reopened.subscribe({ ...input, credentialId: 'device-2', deviceId: 'device-2' });
  now = Date.parse('2026-07-14T20:00:00.000Z');
  assert.deepEqual(await reopened.listActive({ operationId: OPERATION_ID }), []);
  assert.equal(fs.statSync(filePath).mode & 0o077, 0);
});

test('subscription registry rejects foreign requester and bounded-capacity overflow', async (t) => {
  const { createQueryNotebookSubscriptions } = require(
    '../../../engine/src/dashboard/query-notebook-subscriptions.js'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-subscriptions-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createQueryNotebookSubscriptions({
    filePath: path.join(root, 'subscriptions.json'), requesterAgent: 'jerry',
    now: () => NOW, maxEntries: 1,
  });
  const base = {
    requesterAgent: 'jerry', operationId: OPERATION_ID,
    credentialId: 'device-1', deviceId: 'device-1', generation: 1,
    expiresAt: '2026-07-14T20:00:00.000Z', terminalState: null,
  };
  await store.subscribe(base);
  await assert.rejects(() => store.subscribe({
    ...base, credentialId: 'device-2', deviceId: 'device-2',
  }), { code: 'subscription_capacity_exceeded' });
  await assert.rejects(() => store.subscribe({
    ...base, requesterAgent: 'forrest',
  }), { code: 'access_denied' });
});

test('protected facade serves only requester-bound redacted list, status, result, cancel, and action shapes', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  let status = notebookSummary();
  const actionCalls = [];
  const cancelCalls = [];
  const notebookService = {
    async listQueryNotebookAuthorized(input) {
      assert.deepEqual(input, { limit: 25, stateGroup: 'finished' });
      return { schemaVersion: 1, items: [status], nextCursor: null };
    },
    async getQueryNotebookResultAuthorized(operationId) {
      assert.equal(operationId, OPERATION_ID);
      return {
        schemaVersion: 1, operationId, resultVersion: status.resultVersion,
        answer: 'bounded answer', coverage: status.coverage,
        continuation: status.continuation, actions: status.actions,
      };
    },
    async exportQueryNotebookResultAuthorized(operationId, input) {
      assert.equal(operationId, OPERATION_ID);
      assert.deepEqual(input, { format: 'markdown' });
      const content = '# Query Answer\n\nbounded answer\n';
      return {
        schemaVersion: 1, operationId, resultVersion: status.resultVersion,
        format: 'markdown', filename: 'home23-query-AAAAAAAA.md',
        mediaType: 'text/markdown; charset=utf-8',
        bytes: Buffer.byteLength(content),
        sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'), content,
      };
    },
    async resolveAction(input) {
      actionCalls.push(input);
      return {
        operationId: CHILD_OPERATION_ID, operationType: 'pgs',
        requesterAgent: 'jerry', state: 'queued',
      };
    },
  };
  const coordinator = {
    async cancel(operationId) {
      cancelCalls.push(operationId);
      status = notebookSummary({
        executionState: 'cancelled', humanClassification: 'finished',
        resultAvailability: 'absent', answerPreviewAvailable: false,
        resultVersion: null, actions: [], continuation: null,
      });
      const error = new Error('operation_terminal');
      error.code = 'operation_terminal';
      throw error;
    },
    async attach() { throw new Error('not used'); },
    async detach() {},
  };
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth: acceptedAuth(), notebookService,
    getStatusAuthorized: async (operationId) => {
      assert.equal(operationId, OPERATION_ID);
      return status;
    },
    coordinator,
  });
  const app = express();
  app.use('/home23/api/query', express.json({ limit: '64kb', strict: true }), router);
  const server = await listen(app);
  t.after(server.close);

  const list = await jsonRequest(server.base, '/home23/api/query/notebook?limit=25&state=finished');
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.body.items[0].actions.map(({ kind }) => kind), [
    'openResult', 'continueSweep', 'export',
  ]);
  assert.deepEqual(list.body.items[0].notification, {
    subscribed: false, deliveryState: null,
  });
  assert.equal(JSON.stringify(list.body).includes('resultHandle'), false);
  assert.equal(JSON.stringify(list.body).includes('/private/'), false);

  const detail = await jsonRequest(server.base, `/home23/api/query/operations/${OPERATION_ID}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.operationId, OPERATION_ID);
  assert.equal(Object.hasOwn(detail.body, 'answer'), false);
  const result = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/result`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.answer, 'bounded answer');
  assert.deepEqual(result.body.actions.map(({ kind }) => kind), [
    'openResult', 'continueSweep', 'export',
  ]);

  const exported = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/export`, {
      method: 'POST', body: { format: 'markdown' },
    });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(exported.body, {
    schemaVersion: 1, operationId: OPERATION_ID, resultVersion: status.resultVersion,
    format: 'markdown', filename: 'home23-query-AAAAAAAA.md',
    mediaType: 'text/markdown; charset=utf-8', bytes: 31,
    sha256: crypto.createHash('sha256')
      .update('# Query Answer\n\nbounded answer\n', 'utf8').digest('hex'),
    content: '# Query Answer\n\nbounded answer\n',
  });
  for (const forbidden of ['resultHandle', 'relativePath', 'exportedTo', '/private/']) {
    assert.equal(JSON.stringify(exported.body).includes(forbidden), false, forbidden);
  }
  for (const field of ['answer', 'query', 'path', 'resultHandle', 'metadata', 'fileName']) {
    assert.equal((await jsonRequest(server.base,
      `/home23/api/query/operations/${OPERATION_ID}/export`, {
        method: 'POST', body: { format: 'markdown', [field]: 'caller-controlled' },
      })).response.status, 400, field);
  }

  const action = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/actions`, {
      method: 'POST', body: {
        kind: 'continueSweep', actionToken: 'opaque-action-token',
        requestId: `qreq_${'R'.repeat(32)}`,
      },
    });
  assert.equal(action.response.status, 202);
  assert.deepEqual(action.body, {
    schemaVersion: 1, operationId: CHILD_OPERATION_ID,
    requestKind: 'pgs', executionState: 'queued',
  });
  assert.deepEqual(actionCalls, [{
    sourceOperationId: OPERATION_ID, kind: 'continueSweep', actionToken: 'opaque-action-token',
    requestId: `qreq_${'R'.repeat(32)}`,
  }]);

  status = notebookSummary({
    executionState: 'running', humanClassification: 'running', completedAt: null,
    resultAvailability: 'absent', answerPreviewAvailable: false,
    resultVersion: null, actions: [], continuation: null,
  });
  const cancelled = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.executionState, 'cancelled');
  assert.deepEqual(cancelCalls, [OPERATION_ID]);
  assert.deepEqual(cancelled.body.actions.map(({ kind }) => kind), ['none']);
  assert.equal((await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/export`, {
      method: 'POST', body: { format: 'markdown' },
    })).response.status, 404);

  assert.equal((await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}?unexpected=1`)).response.status, 400);
  assert.equal((await jsonRequest(server.base,
    '/home23/api/query/notebook?limit=25&limit=26')).response.status, 400);
  assert.equal((await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/actions`, {
      method: 'POST', body: {
        kind: 'retryFresh', actionToken: 'not-authority', requestId: `qreq_${'R'.repeat(32)}`,
      },
    })).response.status, 400);
  assert.equal((await jsonRequest(server.base, '/home23/api/query/session', {
    method: 'POST', body: {},
  })).response.status, 400);
});

test('authenticated DELETE removes only one terminal operation from visible history', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const hideCalls = [];
  let hideError = null;
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry',
    auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() {
        return { schemaVersion: 1, items: [], nextCursor: null };
      },
      async getQueryNotebookResultAuthorized() { throw new Error('not used'); },
      async hideQueryNotebookOperationAuthorized(operationId) {
        hideCalls.push(operationId);
        if (hideError) throw hideError;
        return { schemaVersion: 1, operationId, hidden: true };
      },
      async resolveAction() { throw new Error('not used'); },
    },
    getStatusAuthorized: async () => { throw new Error('not used'); },
    coordinator: { async cancel() {}, async attach() {}, async detach() {} },
  });
  const app = express();
  app.use('/home23/api/query', express.json({ limit: '64kb', strict: true }), router);
  const server = await listen(app);
  t.after(server.close);

  const removed = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/history`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body, {
    schemaVersion: 1, operationId: OPERATION_ID, hidden: true,
  });
  assert.deepEqual(hideCalls, [OPERATION_ID]);

  assert.equal((await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/history?unexpected=1`, {
      method: 'DELETE',
    })).response.status, 400);
  assert.equal((await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/history`, {
      method: 'DELETE', body: {},
    })).response.status, 400);

  hideError = Object.assign(new Error('operation_not_terminal'), {
    code: 'operation_not_terminal',
  });
  const active = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/history`, { method: 'DELETE' });
  assert.equal(active.response.status, 409);
  assert.equal(active.body.error.code, 'operation_not_terminal');

  hideError = Object.assign(new Error('access_denied'), { code: 'access_denied' });
  const foreign = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/history`, { method: 'DELETE' });
  assert.equal(foreign.response.status, 403);
  assert.equal(foreign.body.error.code, 'access_denied');
});

test('protected export preserves expired, race-lost, and foreign authority errors', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  let current = notebookSummary({
    resultAvailability: 'expired', resultVersion: null, answerPreviewAvailable: false,
  });
  let exportError = null;
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() {
        return { schemaVersion: 1, items: [], nextCursor: null };
      },
      async getQueryNotebookResultAuthorized() { throw new Error('not used'); },
      async exportQueryNotebookResultAuthorized() {
        if (exportError) throw exportError;
        throw new Error('should not export unavailable status');
      },
      async resolveAction() { throw new Error('not used'); },
    },
    getStatusAuthorized: async () => current,
    coordinator: { async cancel() {}, async attach() {}, async detach() {} },
  });
  const app = express();
  app.use('/home23/api/query', express.json(), router);
  const server = await listen(app);
  t.after(server.close);
  const call = () => jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/export`, {
      method: 'POST', body: { format: 'markdown' },
    });

  let response = await call();
  assert.equal(response.response.status, 410);
  assert.equal(response.body.error.code, 'result_expired');

  current = notebookSummary({
    resultAvailability: 'available', resultVersion: `qrv1_${'V'.repeat(43)}`,
  });
  exportError = Object.assign(new Error('result_unavailable'), { code: 'result_unavailable' });
  response = await call();
  assert.equal(response.response.status, 404);
  assert.equal(response.body.error.code, 'result_unavailable');

  current = { ...current, requesterAgent: 'forrest' };
  response = await call();
  assert.equal(response.response.status, 403);
  assert.equal(response.body.error.code, 'access_denied');
});

test('configured export stays hidden for an available non-text result across projections', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const current = notebookSummary({
    resultAvailability: 'available', answerPreviewAvailable: false,
  });
  const result = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    resultVersion: current.resultVersion,
    answer: null,
    coverage: current.coverage,
    continuation: current.continuation,
    actions: current.actions,
  };
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() {
        return { schemaVersion: 1, items: [current], nextCursor: null };
      },
      async getQueryNotebookResultAuthorized() { return result; },
      async exportQueryNotebookResultAuthorized() {
        throw Object.assign(new Error('result_unavailable'), { code: 'result_unavailable' });
      },
      async resolveAction() { throw new Error('not used'); },
    },
    getStatusAuthorized: async () => current,
    coordinator: { async cancel() {}, async attach() {}, async detach() {} },
  });
  const app = express();
  app.use('/home23/api/query', express.json(), router);
  const server = await listen(app);
  t.after(server.close);

  const inventory = await jsonRequest(server.base, '/home23/api/query/notebook');
  const status = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}`);
  const protectedResult = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/result`);
  for (const projection of [inventory.body.items[0], status.body, protectedResult.body]) {
    assert.equal(projection.actions.some(({ kind }) => kind === 'export'), false);
    assert.equal(projection.actions.some(({ kind }) => kind === 'openResult'), true);
  }
  const exported = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/export`, {
      method: 'POST', body: { format: 'markdown' },
    });
  assert.equal(exported.response.status, 404);
  assert.equal(exported.body.error.code, 'result_unavailable');
});

test('notebook inventory loads active subscriptions once for the whole page', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const subscriptionCalls = [];
  const first = notebookSummary();
  const second = notebookSummary({ operationId: CHILD_OPERATION_ID });
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry',
    auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() {
        return { schemaVersion: 1, items: [first, second], nextCursor: null };
      },
      async getQueryNotebookResultAuthorized() { throw new Error('not used'); },
      async resolveAction() { throw new Error('not used'); },
    },
    getStatusAuthorized: async () => { throw new Error('not used'); },
    coordinator: {
      async cancel() { throw new Error('not used'); },
      async attach() { throw new Error('not used'); },
      async detach() {},
    },
    subscriptions: {
      async listActive(input) {
        subscriptionCalls.push(input);
        assert.deepEqual(input, {});
        return [{
          operationId: CHILD_OPERATION_ID,
          credentialId: CREDENTIAL_ID,
          deliveryState: 'active',
        }];
      },
    },
  });
  const app = express();
  app.use('/home23/api/query', router);
  const server = await listen(app);
  t.after(server.close);

  const inventory = await jsonRequest(server.base, '/home23/api/query/notebook');
  assert.equal(inventory.response.status, 200);
  assert.deepEqual(inventory.body.items.map(({ notification }) => notification), [
    { subscribed: false, deliveryState: null },
    { subscribed: true, deliveryState: 'active' },
  ]);
  assert.equal(subscriptionCalls.length, 1);
});

test('facade action algebra exposes only routes backed by executable authority', () => {
  const { decorateActions } = require('../../../engine/src/dashboard/home23-query-notebook-api.js');
  const projected = decorateActions(notebookSummary({
    actions: [{
      kind: 'targetedRetry', token: 'opaque-targeted-token',
      expiresAt: '2026-07-13T20:30:00.000Z',
    }],
  }));
  assert.deepEqual(projected.actions.map(({ kind }) => kind), ['openResult', 'targetedRetry']);
  assert.equal(projected.actions.some(({ kind }) => kind === 'retryFresh'), false);
  assert.equal(projected.actions.some(({ kind }) => kind === 'export'), false);
  const nonText = decorateActions(notebookSummary({
    answerPreviewAvailable: false,
  }), notebookSummary({ answerPreviewAvailable: false }), true);
  assert.equal(nonText.actions.some(({ kind }) => kind === 'export'), false);
  assert.throws(() => decorateActions(notebookSummary({
    actions: [{
      kind: 'continueSweep', token: 'opaque', expiresAt: '2026-07-13T20:30:00Z',
    }],
  })), { code: 'notebook_projection_invalid' });
});

test('facade rejects foreign status and atomically subscribes an already-terminal device route', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const subscriptionCalls = [];
  const enqueued = [];
  let foreign = true;
  const terminal = notebookSummary();
  const subscriptions = {
    async subscribe(input) {
      subscriptionCalls.push(['subscribe', input]);
      return {
        ...input, routeId: `qroute_${'Q'.repeat(32)}`,
        deliveryState: input.terminalState === null ? 'active' : 'pending',
      };
    },
    async unsubscribe(input) { subscriptionCalls.push(['unsubscribe', input]); return true; },
    async markTerminalPending(input) {
      subscriptionCalls.push(['pending', input]);
      return [{ routeId: `qroute_${'Q'.repeat(32)}`, deliveryState: 'pending' }];
    },
  };
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() { return { schemaVersion: 1, items: [], nextCursor: null }; },
      async getQueryNotebookResultAuthorized() { return {}; },
      async resolveAction() { return {}; },
    },
    getStatusAuthorized: async () => foreign
      ? { ...terminal, requesterAgent: 'forrest' }
      : terminal,
    coordinator: { async cancel() {}, async attach() {}, async detach() {} },
    subscriptions,
    enqueueTerminalNotification: async (entry) => { enqueued.push(entry); },
  });
  const app = express();
  app.use('/home23/api/query', express.json(), router);
  const server = await listen(app);
  t.after(server.close);

  assert.equal((await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}`)).response.status, 403);
  foreign = false;
  const subscribed = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/notifications`, {
      method: 'POST', body: { enabled: true },
    });
  assert.equal(subscribed.response.status, 200);
  assert.equal(subscribed.body.deliveryState, 'pending');
  assert.equal(subscriptionCalls[0][1].terminalState, 'partial');
  assert.equal(subscriptionCalls[0][1].expiresAt, '2026-07-14T20:00:00.000Z');
  assert.equal(subscriptionCalls[0][1].generation, 2);
  assert.equal(subscriptionCalls[0][1].deviceId, DEVICE_INSTALLATION_ID);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].routeId, `qroute_${'Q'.repeat(32)}`);

  const removed = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/notifications`, {
      method: 'POST', body: { enabled: false },
    });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.subscribed, false);
  const webRejected = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/notifications`, {
      method: 'POST', body: { enabled: true }, headers: { 'x-test-web': '1' },
    });
  assert.equal(webRejected.response.status, 403);
});

test('notification subscribe closes the status-read terminal race before responding', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  let reads = 0;
  const calls = [];
  const pending = {
    requesterAgent: 'jerry', operationId: OPERATION_ID,
    credentialId: CREDENTIAL_ID, deviceId: DEVICE_INSTALLATION_ID, generation: 2,
    expiresAt: '2026-07-14T20:00:00.000Z',
    terminalState: 'complete', routeId: `qroute_${'Q'.repeat(32)}`,
    deliveryState: 'pending',
  };
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() { return { schemaVersion: 1, items: [], nextCursor: null }; },
      async getQueryNotebookResultAuthorized() { return {}; },
      async resolveAction() { return {}; },
    },
    getStatusAuthorized: async () => {
      reads += 1;
      return notebookSummary(reads === 1 ? {
        executionState: 'running', humanClassification: 'running',
        resultAvailability: 'absent', answerPreviewAvailable: false,
        resultVersion: null, actions: [], continuation: null,
      } : { executionState: 'complete', error: null, actions: [] });
    },
    coordinator: { async cancel() {}, async attach() {}, async detach() {} },
    subscriptions: {
      async subscribe(input) {
        calls.push(['subscribe', input]);
        return { ...pending, terminalState: null, deliveryState: 'active' };
      },
      async unsubscribe() { return false; },
      async markTerminalPending(input) { calls.push(['pending', input]); return [pending]; },
    },
    enqueueTerminalNotification: async (entry) => calls.push(['enqueue', entry]),
  });
  const app = express();
  app.use('/home23/api/query', express.json(), router);
  const server = await listen(app);
  t.after(server.close);
  const response = await jsonRequest(server.base,
    `/home23/api/query/operations/${OPERATION_ID}/notifications`, {
      method: 'POST', body: { enabled: true },
    });
  assert.equal(response.response.status, 200);
  assert.equal(response.body.deliveryState, 'pending');
  assert.deepEqual(calls.map(([kind]) => kind), ['subscribe', 'pending', 'enqueue']);
  assert.equal(calls[0][1].expiresAt, '2026-07-14T20:00:00.000Z');
});

test('early placeholder bounds notebook bodies without intercepting legacy Query routes', async (t) => {
  const { createQueryNotebookPlaceholderRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const unavailable = createQueryNotebookPlaceholderRouter({ limitBytes: 128 });
  const unavailableApp = express();
  unavailableApp.use('/home23/api/query', unavailable.router);
  let legacyBodyParsed = false;
  unavailableApp.use(express.json({ limit: '1mb' }));
  unavailableApp.post('/home23/api/query/run', (req, res) => {
    legacyBodyParsed = true;
    res.json({ legacy: req.body.query });
  });
  const unavailableServer = await listen(unavailableApp);
  t.after(unavailableServer.close);
  assert.equal((await jsonRequest(unavailableServer.base, '/home23/api/query/notebook')).response.status,
    503);
  const legacy = await jsonRequest(unavailableServer.base, '/home23/api/query/run', {
    method: 'POST', body: { query: 'legacy remains' },
  });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.body.legacy, 'legacy remains');
  assert.equal(legacyBodyParsed, true);

  const attached = createQueryNotebookPlaceholderRouter({ limitBytes: 128 });
  attached.attach(express.Router().post(`/operations/${OPERATION_ID}/actions`,
    (req, res) => res.json({ parsed: req.body, bounded: req.queryNotebookBodyParsed })));
  const attachedApp = express();
  attachedApp.use('/home23/api/query', attached.router);
  attachedApp.use((req, _res, next) => {
    if (req.queryNotebookBodyParsed === true) return next();
    throw new Error('broad parser reached protected request');
  });
  const attachedServer = await listen(attachedApp);
  t.after(attachedServer.close);
  const bounded = await jsonRequest(attachedServer.base,
    `/home23/api/query/operations/${OPERATION_ID}/actions`, {
      method: 'POST', body: { ok: true },
    });
  assert.equal(bounded.response.status, 200);
  assert.equal(bounded.body.bounded, true);
  const tooLarge = await fetch(
    `${attachedServer.base}/home23/api/query/operations/${OPERATION_ID}/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(512) }),
    });
  assert.equal(tooLarge.status, 413);
});

test('SSE authenticates before headers and projects only snapshot progress heartbeat gap and terminal', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const attached = [];
  const detached = [];
  const events = [
    { sequence: 2, type: 'provider_call_started', secret: '/private/provider-key' },
    {
      sequence: 3, type: 'progress',
      progressSnapshot: {
        version: 1, stage: 'sweeping', eventSequence: 3,
        completed: 1, pending: 2, lastProgressAt: '2026-07-13T20:00:01.000Z',
      },
      rawProviderPayload: 'forbidden',
    },
    { sequence: 4, type: 'heartbeat', at: '2026-07-13T20:00:02.000Z', secret: 'no' },
    {
      type: 'event_gap', eventSequence: 5,
      oldestSequence: 4, latestSequence: 5, providerFrames: ['no'],
    },
    { sequence: 6, type: 'state', state: 'complete', resultHandle: 'forbidden' },
  ];
  const coordinator = {
    async cancel() {},
    async attach(operationId, input) {
      attached.push([operationId, input]);
      return { async nextEvent() { return events.shift() ?? null; } };
    },
    async detach(operationId, input) { detached.push([operationId, input]); },
  };
  const status = notebookSummary({
    executionState: 'running', humanClassification: 'running', completedAt: null,
    resultAvailability: 'absent', answerPreviewAvailable: false, resultVersion: null,
    actions: [], continuation: null,
    progress: { version: 1, stage: 'sweeping', eventSequence: 1, completed: 0, pending: 3 },
  });
  let rejectAuth = true;
  const auth = acceptedAuth();
  const accepted = auth.requireCredential;
  auth.requireCredential = (req, res, next) => {
    if (rejectAuth) return res.status(401).json({ ok: false, error: { code: 'unauthorized' } });
    return accepted(req, res, next);
  };
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth,
    notebookService: {
      async listQueryNotebookAuthorized() { return { schemaVersion: 1, items: [], nextCursor: null }; },
      async getQueryNotebookResultAuthorized() { return {}; },
      async resolveAction() { return {}; },
    },
    getStatusAuthorized: async () => status,
    coordinator,
  });
  const app = express();
  app.use('/home23/api/query', router);
  const server = await listen(app);
  t.after(server.close);
  const route = `/home23/api/query/operations/${OPERATION_ID}/events?after=0&attachmentId=notebook-test`;
  const denied = await fetch(`${server.base}${route}`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('content-type'), /application\/json/);
  assert.equal(attached.length, 0);

  rejectAuth = false;
  const response = await fetch(`${server.base}${route}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const text = await response.text();
  assert.deepEqual([...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]), [
    'snapshot', 'progress', 'heartbeat', 'gap', 'terminal',
  ]);
  assert.equal(text.includes('provider_call_started'), false);
  assert.equal(text.includes('rawProviderPayload'), false);
  assert.equal(text.includes('resultHandle'), false);
  assert.equal(text.includes('/private/'), false);
  assert.match(text, /"notification":\{"subscribed":false,"deliveryState":null\}/);
  assert.match(text, /event: gap\ndata: \{"type":"gap","operationId":"brop_A{32}","eventSequence":5,"fromSequence":4,"toSequence":5\}/);
  assert.equal(attached.length, 1);
  assert.equal(attached[0][0], OPERATION_ID);
  assert.equal(attached[0][1].afterSequence, 0);
  assert.equal(attached[0][1].attachmentId, 'notebook-test');
  assert.deepEqual(detached, [[OPERATION_ID, {
    attachmentId: 'notebook-test', reason: 'client_closed',
  }]]);
});

test('SSE client close aborts and detaches only its attachment', async (t) => {
  const { createHome23QueryNotebookRouter } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  let detachInput = null;
  let attachmentSignal = null;
  const never = new Promise(() => {});
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry', auth: acceptedAuth(),
    notebookService: {
      async listQueryNotebookAuthorized() { return { schemaVersion: 1, items: [], nextCursor: null }; },
      async getQueryNotebookResultAuthorized() { return {}; },
      async resolveAction() { return {}; },
    },
    getStatusAuthorized: async () => notebookSummary({
      executionState: 'running', humanClassification: 'running',
      resultAvailability: 'absent', answerPreviewAvailable: false,
      resultVersion: null, actions: [], continuation: null,
    }),
    coordinator: {
      async cancel() {},
      async attach(_operationId, input) {
        attachmentSignal = input.signal;
        return { async nextEvent() { await never; return null; } };
      },
      async detach(_operationId, input) { detachInput = input; },
    },
  });
  const app = express();
  app.use('/home23/api/query', router);
  const server = await listen(app);
  t.after(server.close);
  const controller = new AbortController();
  const response = await fetch(
    `${server.base}/home23/api/query/operations/${OPERATION_ID}/events?after=0&attachmentId=close-me`,
    { signal: controller.signal },
  );
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(() => reader.read(), { name: 'AbortError' });
  for (let attempt = 0; attempt < 100 && detachInput === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(attachmentSignal.aborted, true);
  assert.deepEqual(detachInput, { attachmentId: 'close-me', reason: 'client_closed' });
});

test('SSE writer waits for drain before producing another frame', async () => {
  const { writeNotebookSseFrame } = require(
    '../../../engine/src/dashboard/home23-query-notebook-api.js'
  );
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = false;
  response.write = () => false;
  const controller = new AbortController();
  let settled = false;
  const writing = writeNotebookSseFrame(response, 'data: {}\n\n', controller.signal)
    .then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  response.emit('drain');
  await writing;
  assert.equal(settled, true);
});

test('DashboardServer mounts the protected placeholder before compatibility and broad parsers', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'engine/src/dashboard/server.js'), 'utf8',
  );
  const placeholder = source.indexOf('createQueryNotebookPlaceholderRouter');
  const protectedMount = source.indexOf("this.app.use('/home23/api/query', this.queryNotebookPlaceholder.router)");
  const compatibilityMount = source.indexOf("this.app.use('/home23/api/query', this.queryCompatibilityBodyParser)");
  const broadParser = source.indexOf("express.json({ limit: '10gb' })");
  assert.ok(placeholder >= 0);
  assert.ok(protectedMount > placeholder);
  assert.ok(compatibilityMount > protectedMount);
  assert.ok(broadParser > compatibilityMount);
  assert.match(source, /if \(req\.queryNotebookBodyParsed === true\) return next\(\);/);
  assert.match(source, /this\.queryNotebookPlaceholder\.attach\(router\);/);
});

test('DashboardServer binds Query visibility authority to the selected runtime directory', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'engine/src/dashboard/server.js'), 'utf8',
  );
  assert.match(source, /createQueryNotebookVisibilityStore/);
  assert.match(source,
    /path\.join\(this\.defaultRunDir, 'query-notebook-visibility\.json'\)/);
  assert.match(source, /createQueryNotebookService\(\{[\s\S]*visibilityStore/);
  assert.match(source, /this\.queryNotebookVisibilityStore = visibilityStore/);
});

test('DashboardServer verifies shared credentials from agent or secrets config before env', async (t) => {
  const { DashboardServer } = require('../../../engine/src/dashboard/server.js');
  const { createQueryNotebookCredentialAuthority } = require(
    '../../../shared/query-notebook-credential.cjs'
  );
  const priorBridgeToken = process.env.BRIDGE_TOKEN;
  const priorHome23BridgeToken = process.env.HOME23_BRIDGE_TOKEN;
  delete process.env.BRIDGE_TOKEN;
  delete process.env.HOME23_BRIDGE_TOKEN;
  t.after(() => {
    if (priorBridgeToken === undefined) delete process.env.BRIDGE_TOKEN;
    else process.env.BRIDGE_TOKEN = priorBridgeToken;
    if (priorHome23BridgeToken === undefined) delete process.env.HOME23_BRIDGE_TOKEN;
    else process.env.HOME23_BRIDGE_TOKEN = priorHome23BridgeToken;
  });

  async function startDashboardWithConfig({ agentToken, secretToken }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-dashboard-auth-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const instanceDir = path.join(root, 'instances', 'jerry');
    const runtimeDir = path.join(instanceDir, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'config.yaml'), [
      'channels:',
      '  webhooks:',
      `    token: ${JSON.stringify(agentToken ?? '')}`,
      '',
    ].join('\n'));
    if (secretToken !== undefined) {
      fs.mkdirSync(path.join(root, 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), [
        'bridge:',
        `  token: ${JSON.stringify(secretToken)}`,
        '',
      ].join('\n'));
    }
    const dashboard = Object.create(DashboardServer.prototype);
    dashboard.defaultRunDir = runtimeDir;
    dashboard.getHome23AgentName = () => 'jerry';
    dashboard.getHome23Root = () => root;
    dashboard.brainOperationsReader = {};
    dashboard.brainOperationsCoordinator = {
      async start() { throw new Error('not used'); },
      async cancel() { throw new Error('not used'); },
      async attach() { throw new Error('not used'); },
      async detach() {},
    };
    let notebookRouter;
    dashboard.queryNotebookPlaceholder = { attach(value) { notebookRouter = value; } };
    dashboard.initializeQueryNotebook({
      lookupDeviceCredential: async () => ({
        installation_id: DEVICE_INSTALLATION_ID,
        requester_agent: 'jerry', credential_id: CREDENTIAL_ID,
        credential_generation: 2, revoked_at: null,
      }),
      notebookService: {
        async listQueryNotebookAuthorized() {
          return { schemaVersion: 1, items: [], nextCursor: null };
        },
        async getQueryNotebookStatusAuthorized() { throw new Error('not used'); },
        async getQueryNotebookResultAuthorized() { throw new Error('not used'); },
        async resolveAction() { throw new Error('not used'); },
      },
      subscriptions: { async listActive() { return []; } },
    });
    const app = express();
    app.use('/home23/api/query', notebookRouter);
    const listening = await listen(app);
    t.after(listening.close);
    return listening;
  }

  const bridgeToken = 'config-only-bridge-token-'.padEnd(64, 'x');
  const credentialNow = Date.now();
  const credentialExpiresAt = new Date(credentialNow + (24 * 60 * 60 * 1000)).toISOString();
  const authority = createQueryNotebookCredentialAuthority({
    bridgeToken, requesterAgent: 'jerry', now: () => credentialNow,
  });
  const credential = authority.issue({
    audience: 'device', credentialId: CREDENTIAL_ID, requesterKind: 'device',
    generation: 2, expiresAt: credentialExpiresAt,
  });
  const headers = {
    authorization: `Bearer ${credential}`,
    'x-home23-device-id': CREDENTIAL_ID,
  };

  const configured = await startDashboardWithConfig({ agentToken: bridgeToken });
  assert.equal((await fetch(`${configured.base}/home23/api/query/notebook`, { headers })).status,
    200);
  const secretConfigured = await startDashboardWithConfig({
    agentToken: 'too-short', secretToken: bridgeToken,
  });
  assert.equal((await fetch(`${secretConfigured.base}/home23/api/query/notebook`, {
    headers,
  })).status, 200);
  const short = await startDashboardWithConfig({ agentToken: 'too-short' });
  const unavailable = await fetch(`${short.base}/home23/api/query/notebook`, { headers });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    ok: false,
    error: { code: 'query_notebook_auth_unavailable', retryable: true },
  });
});
