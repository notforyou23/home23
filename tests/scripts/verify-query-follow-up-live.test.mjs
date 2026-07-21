import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const verifierUrl = new URL('../../scripts/verify-query-follow-up-live.mjs', import.meta.url);
const BRIDGE_SECRET = 'bridge-super-secret';
const DEVICE_SECRET = 'device.super-secret';
const PRIVATE_CONTEXT = 'private-parent-context-must-never-echo';
const ROOT = `brop_${'A'.repeat(32)}`;
const CHILD = `brop_${'B'.repeat(32)}`;
const GRANDCHILD = `brop_${'C'.repeat(32)}`;
const VERSIONS = new Map([
  [ROOT, `qrv1_${'A'.repeat(43)}`],
  [CHILD, `qrv1_${'B'.repeat(43)}`],
  [GRANDCHILD, `qrv1_${'C'.repeat(43)}`],
]);
const PROTECTED_GENERIC_FIELDS = [
  'kind', 'schemaVersion', 'followUpFrom', 'queryFollowUpLineage',
  '_queryFollowUpContext', 'verifiedConversationContext',
];

async function verifier() {
  return import(verifierUrl.href);
}

function fixture(name) {
  return JSON.parse(readFileSync(
    new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8',
  ));
}

function lineage(operationId) {
  if (operationId === ROOT) return null;
  const parentOperationId = operationId === CHILD ? ROOT : CHILD;
  return {
    rootOperationId: ROOT,
    parentOperationId,
    parentResultVersion: VERSIONS.get(parentOperationId),
    depth: operationId === CHILD ? 1 : 2,
    availableExchangeCount: operationId === CHILD ? 1 : 2,
    includedExchangeCount: operationId === CHILD ? 1 : 2,
    contextTruncated: false,
    sourceAnswerTruncated: false,
  };
}

function summary(operationId, projected = false) {
  const value = structuredClone(fixture('query-notebook-status-follow-up-projection'));
  value.operationId = operationId;
  value.resultVersion = VERSIONS.get(operationId);
  value.question = operationId === ROOT ? 'Root question' : operationId === CHILD
    ? 'First follow up' : 'Second follow up';
  value.questionTitle = value.question;
  value.requestKind = 'direct';
  value.configuration = {
    directMode: 'dive', directModel: { provider: 'openai', model: 'gpt-5.2' },
  };
  if (projected) value.followUpLineage = lineage(operationId);
  else delete value.followUpLineage;
  return value;
}

function result(operationId, versionOverride) {
  const value = structuredClone(fixture('query-notebook-result'));
  value.operationId = operationId;
  value.resultVersion = versionOverride ?? VERSIONS.get(operationId);
  value.answer = `TOP SECRET ANSWER ${operationId} ${PRIVATE_CONTEXT}`;
  return value;
}

function page(projected) {
  const items = [ROOT, CHILD, GRANDCHILD].map((id) => summary(id, projected));
  return {
    schemaVersion: 1, items, nextCursor: null, omittedIncompatibleCount: 0,
  };
}

function json(res, status, value, headers = {}) {
  const encoded = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded), ...headers,
  });
  res.end(encoded);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fakeSystem({
  keepRootRunning = false,
  resultVersionMismatch = null,
  inventoryMode = 'complete',
  mutateSnapshot = false,
  silentlyAcceptGenericField = null,
} = {}) {
  const observations = {
    protectedStarts: [], genericRejected: false, genericRootStarts: 0,
    enrollmentAuthorization: null,
  };
  const accepted = new Map();
  let nextChild = 0;
  const serverPromise = listen(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const rawBody = await readBody(req);
    const body = rawBody ? JSON.parse(rawBody) : null;

    if (req.method === 'POST' && url.pathname === '/api/device/query-credential') {
      observations.enrollmentAuthorization = req.headers.authorization;
      return json(res, 200, {
        credentialId: `qncred_${'D'.repeat(32)}`,
        token: DEVICE_SECRET,
        generation: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (url.pathname === '/home23/api/query/catalog') {
      return json(res, 200, {
        agent: 'jerry', available: true,
        selectedBrain: { id: 'brain-jerry', displayName: 'Jerry' },
        models: [{ provider: 'openai', id: 'gpt-5.2' }],
        defaults: { provider: 'openai', model: 'gpt-5.2', mode: 'dive' },
        limits: {
          verifiedFollowUp: true,
          followUpProjection: 'follow-up-v1',
          maxPriorContextChars: 20_000,
        },
      });
    }
    if (req.method === 'POST' && url.pathname === '/home23/api/query/run') {
      const presentProtected = PROTECTED_GENERIC_FIELDS.filter((field) => (
        Object.hasOwn(body, field)
      ));
      if (presentProtected.length > 0
          && !(presentProtected.length === 1
            && presentProtected[0] === silentlyAcceptGenericField)) {
        observations.genericRejected = true;
        return json(res, 400, { ok: false, error: {
          code: 'invalid_request', message: 'request contains an unsupported field',
          retryable: false,
        } });
      }
      observations.genericRootStarts += 1;
      return json(res, 202, {
        operationId: ROOT, state: 'queued', detached: true, attachmentState: 'detached',
      });
    }
    const authorized = req.headers.authorization === `Bearer ${DEVICE_SECRET}`
      && req.headers['x-home23-device-id'] === `qncred_${'D'.repeat(32)}`;
    if (!authorized) return json(res, 401, { ok: false, error: { code: 'unauthorized' } });

    if (req.method === 'GET' && url.pathname === '/home23/api/query/notebook') {
      const projected = url.searchParams.get('projection') === 'follow-up-v1';
      const value = page(projected);
      if (inventoryMode === 'empty') value.items = [];
      if (inventoryMode === 'mutated' && projected) {
        value.items.find((item) => item.operationId === CHILD)
          .followUpLineage.parentOperationId = GRANDCHILD;
      }
      return json(res, 200, value);
    }
    if (req.method === 'POST' && url.pathname === '/home23/api/query/operations') {
      const requestId = req.headers['x-home23-query-request-id'];
      observations.protectedStarts.push({ requestId, rawBody, body });
      let operationId = accepted.get(requestId);
      if (!operationId) {
        operationId = nextChild++ === 0 ? CHILD : GRANDCHILD;
        accepted.set(requestId, operationId);
      }
      return json(res, 202, { schemaVersion: 1, requestId, operationId });
    }
    const match = /^\/home23\/api\/query\/operations\/(brop_[A-Za-z0-9_-]{32})(?:\/(result|events))?$/u.exec(url.pathname);
    if (!match) return json(res, 404, { error: 'not_found' });
    const operationId = match[1];
    if (match[2] === 'result') return json(res, 200, result(
      operationId,
      resultVersionMismatch === operationId ? `qrv1_${'Z'.repeat(43)}` : undefined,
    ));
    if (match[2] === 'events') {
      const projectedSnapshot = url.searchParams.get('projection') === 'follow-up-v1';
      const snapshot = {
        type: 'snapshot', operationId, eventSequence: 8,
        executionState: 'complete', progress: summary(operationId).progress,
        error: null, resultAvailability: 'available', resultVersion: VERSIONS.get(operationId),
        actions: [{ kind: 'openResult' }, { kind: 'export' }],
        notification: { subscribed: false, deliveryState: null },
        ...(projectedSnapshot ? { followUpLineage: lineage(operationId) } : {}),
      };
      if (mutateSnapshot && projectedSnapshot && operationId === GRANDCHILD) {
        snapshot.followUpLineage.parentOperationId = ROOT;
      }
      const encoded = `id: 8\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(encoded);
    }
    const projected = url.searchParams.get('projection') === 'follow-up-v1';
    const value = summary(operationId, projected);
    if (keepRootRunning && operationId === ROOT) {
      const running = structuredClone(fixture('query-notebook-status'));
      running.operationId = ROOT;
      running.configuration = value.configuration;
      running.question = value.question;
      running.questionTitle = value.questionTitle;
      return json(res, 200, running);
    }
    return json(res, 200, value);
  });
  return { serverPromise, observations };
}

async function tokenFixture(t, mode = 0o600) {
  const directory = await mkdtemp(path.join(tmpdir(), 'follow-up-verifier-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'bridge-token');
  await writeFile(tokenFile, `${BRIDGE_SECRET}\n`, { mode: 0o600 });
  await chmod(tokenFile, mode);
  return { directory, tokenFile };
}

function options(origin, files, overrides = {}) {
  return {
    agent: 'jerry', dashboardUrl: origin, harnessUrl: origin,
    bridgeTokenFile: files.tokenFile,
    output: path.join(files.directory, 'receipt.json'),
    pollMs: 5, connectTimeoutMs: 250, requestTimeoutMs: 250,
    overallTimeoutMs: 2_000, maxResponseBytes: 128 * 1024,
    maxReceiptBytes: 256 * 1024, ...overrides,
  };
}

test('requires a regular single-link 0600 token file before any enrollment request', async (t) => {
  const files = await tokenFixture(t, 0o644);
  const { runVerifier } = await verifier();
  await assert.rejects(runVerifier(options('http://127.0.0.1:1', files)), {
    code: 'bridge_token_file_unsafe',
  });
});

test('proves legacy and opted shapes plus a real root-child-grandchild chain without echoing secrets', async (t) => {
  const files = await tokenFixture(t);
  const fake = fakeSystem();
  const server = await fake.serverPromise;
  t.after(server.close);
  const { runVerifier, encodeReceipt } = await verifier();
  const receipt = await runVerifier(options(server.origin, files));
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.operations.map(({ operationId }) => operationId), [ROOT, CHILD, GRANDCHILD]);
  assert.deepEqual(receipt.operations.map(({ depth }) => depth), [0, 1, 2]);
  assert.equal(receipt.compatibility.legacyInventory.hasFollowUpLineage, false);
  assert.equal(receipt.compatibility.legacyStatus.hasFollowUpLineage, false);
  assert.equal(receipt.compatibility.legacySnapshot.hasFollowUpLineage, false);
  assert.equal(receipt.compatibility.optedRoot.lineage, null);
  assert.equal(receipt.compatibility.optedChild.lineage.depth, 1);
  assert.equal(receipt.compatibility.optedGrandchild.lineage.depth, 2);
  assert.equal(receipt.compatibility.resultHasLineage, false);
  assert.deepEqual(receipt.genericRunProtectedFields, PROTECTED_GENERIC_FIELDS.map((field) => ({
    field, status: 400, code: 'invalid_request',
  })));
  assert.equal(fake.observations.genericRejected, true);
  assert.equal(fake.observations.enrollmentAuthorization, `Bearer ${BRIDGE_SECRET}`);

  assert.equal(fake.observations.protectedStarts.length, 4);
  for (let index = 0; index < 4; index += 2) {
    assert.equal(fake.observations.protectedStarts[index].requestId,
      fake.observations.protectedStarts[index + 1].requestId);
    assert.equal(fake.observations.protectedStarts[index].rawBody,
      fake.observations.protectedStarts[index + 1].rawBody);
  }
  const encoded = encodeReceipt(receipt, 256 * 1024);
  for (const forbidden of [BRIDGE_SECRET, DEVICE_SECRET, 'TOP SECRET ANSWER', PRIVATE_CONTEXT]) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }
  for (const operation of receipt.operations) {
    assert.equal(operation.requestKind, 'direct');
    assert.deepEqual(operation.configuration, {
      directMode: 'dive', directModel: { provider: 'openai', model: 'gpt-5.2' },
    });
    assert.deepEqual(operation.actions, ['openResult', 'export']);
    assert.match(operation.result.answerSha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(fake.observations.genericRootStarts, 1);
});

test('can use an explicit existing terminal parent without starting a replacement root', async (t) => {
  const files = await tokenFixture(t);
  const fake = fakeSystem();
  const server = await fake.serverPromise;
  t.after(server.close);
  const { runVerifier } = await verifier();
  const receipt = await runVerifier(options(server.origin, files, {
    parentOperationId: ROOT, parentResultVersion: VERSIONS.get(ROOT),
  }));
  assert.equal(receipt.root.source, 'existing-parent');
  assert.deepEqual(receipt.operations.map(({ operationId }) => operationId), [ROOT, CHILD, GRANDCHILD]);
  assert.equal(fake.observations.genericRootStarts, 0);
});

test('enforces connect, response-body, and overall deadlines', async (t) => {
  const files = await tokenFixture(t);
  const hanging = await listen((_req, _res) => {});
  t.after(hanging.close);
  const { requestJson, runVerifier } = await verifier();
  await assert.rejects(requestJson(`${hanging.origin}/hang`, {
    connectTimeoutMs: 25, requestTimeoutMs: 100, maxBytes: 1024,
  }), { code: 'connect_timeout' });

  const slowBody = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"never":');
  });
  t.after(slowBody.close);
  await assert.rejects(requestJson(`${slowBody.origin}/slow`, {
    connectTimeoutMs: 100, requestTimeoutMs: 25, maxBytes: 1024,
  }), { code: 'request_timeout' });

  const fake = fakeSystem({ keepRootRunning: true });
  const server = await fake.serverPromise;
  t.after(server.close);
  await assert.rejects(runVerifier(options(server.origin, files, {
    overallTimeoutMs: 80, connectTimeoutMs: 50, requestTimeoutMs: 50,
  })), { code: 'overall_timeout' });
});

test('rejects declared and streamed responses beyond the configured ceiling', async (t) => {
  const { requestJson } = await verifier();
  const declared = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '99999' });
    res.end('{}');
  });
  t.after(declared.close);
  await assert.rejects(requestJson(`${declared.origin}/large`, {
    connectTimeoutMs: 100, requestTimeoutMs: 100, maxBytes: 32,
  }), { code: 'response_too_large' });

  const streamed = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: 'x'.repeat(128) }));
  });
  t.after(streamed.close);
  await assert.rejects(requestJson(`${streamed.origin}/large`, {
    connectTimeoutMs: 100, requestTimeoutMs: 100, maxBytes: 32,
  }), { code: 'response_too_large' });
});

test('fails closed on malformed public contract shapes', async (t) => {
  const files = await tokenFixture(t);
  const server = await listen(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    await readBody(req);
    if (url.pathname === '/api/device/query-credential') {
      return json(res, 200, { credentialId: 'not-a-credential', token: DEVICE_SECRET });
    }
    return json(res, 500, { error: 'unexpected' });
  });
  t.after(server.close);
  const { runVerifier } = await verifier();
  await assert.rejects(runVerifier(options(server.origin, files)), {
    code: 'public_projection_invalid',
  });
});

test('rejects a terminal status/result version mismatch before chaining', async (t) => {
  const files = await tokenFixture(t);
  for (const resultVersionMismatch of [ROOT, CHILD, GRANDCHILD]) {
    const fake = fakeSystem({ resultVersionMismatch });
    const server = await fake.serverPromise;
    t.after(server.close);
    const { runVerifier } = await verifier();
    await assert.rejects(runVerifier(options(server.origin, files)), {
      code: 'result_version_mismatch',
    }, resultVersionMismatch);
  }
});

test('rejects empty or lineage-mutated chain inventory pages', async (t) => {
  const files = await tokenFixture(t);
  for (const inventoryMode of ['empty', 'mutated']) {
    const fake = fakeSystem({ inventoryMode });
    const server = await fake.serverPromise;
    t.after(server.close);
    const { runVerifier } = await verifier();
    await assert.rejects(runVerifier(options(server.origin, files)), {
      code: 'inventory_chain_unproven',
    });
  }
});

test('rejects a schema-valid but ancestry-mutated projected snapshot', async (t) => {
  const files = await tokenFixture(t);
  const fake = fakeSystem({ mutateSnapshot: true });
  const server = await fake.serverPromise;
  t.after(server.close);
  const { runVerifier } = await verifier();
  await assert.rejects(runVerifier(options(server.origin, files)), {
    code: 'lineage_invalid',
  });
});

test('fails if any protected generic field is silently accepted', async (t) => {
  const files = await tokenFixture(t);
  const fake = fakeSystem({ silentlyAcceptGenericField: 'queryFollowUpLineage' });
  const server = await fake.serverPromise;
  t.after(server.close);
  const { runVerifier } = await verifier();
  await assert.rejects(runVerifier(options(server.origin, files)), {
    code: 'unexpected_http_status',
  });
});
