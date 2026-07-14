import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { DeviceRegistry } from '../../src/push/device-registry.js';
import {
  createQueryCredentialHandler,
  createQueryCredentialJsonParser,
} from '../../src/routes/device.js';
import { resolveQueryNotebookBridgeToken } from '../../src/query-notebook-credential-config.js';

const require = createRequire(import.meta.url);
const {
  QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES,
  QUERY_NOTEBOOK_CREDENTIAL_DOMAIN,
  createQueryNotebookCredentialAuthority,
  deriveQueryNotebookCredentialKey,
} = require('../../shared/query-notebook-credential.cjs');

const NOW = '2026-07-13T16:00:00.000Z';
const LATER = '2026-07-13T16:10:00.000Z';
const BRIDGE_TOKEN = `bridge_${'b'.repeat(64)}`;

test('harness and dashboard authority can share the secrets bridge token', () => {
  assert.equal(resolveQueryNotebookBridgeToken({
    channels: { webhooks: { token: '' } },
    bridge: { token: BRIDGE_TOKEN },
  }, {
    BRIDGE_TOKEN: 'environment-fallback',
  }), BRIDGE_TOKEN);
  assert.equal(resolveQueryNotebookBridgeToken({
    channels: { webhooks: { token: 'agent-token' } },
    bridge: { token: BRIDGE_TOKEN },
  }, {}), 'agent-token');
  assert.equal(resolveQueryNotebookBridgeToken({}, {
    HOME23_BRIDGE_TOKEN: 'home23-environment-fallback',
  }), 'home23-environment-fallback');
});
const CREDENTIAL_ID = `qncred_${'C'.repeat(32)}`;

function withTempRegistry(run: (filePath: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'home23-query-credential-'));
  try {
    run(join(directory, 'device-registry.json'), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function authority(requesterAgent = 'jerry') {
  let now = Date.parse(NOW);
  const value = createQueryNotebookCredentialAuthority({
    bridgeToken: BRIDGE_TOKEN,
    requesterAgent,
    now: () => now,
  });
  return { value, setNow: (next: string) => { now = Date.parse(next); } };
}

test('query notebook credentials use agent-bound HKDF and exact signed claims', () => {
  assert.equal(QUERY_NOTEBOOK_CREDENTIAL_DOMAIN, 'home23.query-notebook.credential.v1');
  assert.deepEqual(QUERY_NOTEBOOK_CREDENTIAL_AUDIENCES, {
    device: 'device', webSession: 'web-session',
  });
  const jerryKey = deriveQueryNotebookCredentialKey({
    bridgeToken: BRIDGE_TOKEN,
    requesterAgent: 'jerry',
  });
  const repeatedKey = deriveQueryNotebookCredentialKey({
    bridgeToken: BRIDGE_TOKEN,
    requesterAgent: 'jerry',
  });
  const forrestKey = deriveQueryNotebookCredentialKey({
    bridgeToken: BRIDGE_TOKEN,
    requesterAgent: 'forrest',
  });
  assert.equal(Buffer.isBuffer(jerryKey), true);
  assert.equal(jerryKey.length, 32);
  assert.deepEqual(jerryKey, repeatedKey);
  assert.notDeepEqual(jerryKey, forrestKey);
  assert.equal(jerryKey.includes(Buffer.from(BRIDGE_TOKEN)), false);

  const { value } = authority();
  const token = value.issue({
    audience: 'device',
    credentialId: CREDENTIAL_ID,
    requesterKind: 'device',
    generation: 7,
    expiresAt: LATER,
  });
  const claims = value.verify(token, {
    audience: 'device',
    credentialId: CREDENTIAL_ID,
    requesterKind: 'device',
    generation: 7,
  });
  assert.deepEqual(Object.keys(claims).sort(), [
    'audience', 'credentialId', 'expiresAt', 'generation', 'issuedAt',
    'requesterAgent', 'requesterKind', 'v',
  ]);
  assert.deepEqual(claims, {
    v: 1,
    audience: 'device',
    requesterAgent: 'jerry',
    credentialId: CREDENTIAL_ID,
    requesterKind: 'device',
    generation: 7,
    issuedAt: NOW,
    expiresAt: LATER,
  });
  assert.equal(token.includes(BRIDGE_TOKEN), false);
});

test('query notebook credentials reject tamper, drift, generic HMAC, and expiry', () => {
  const { value, setNow } = authority();
  const token = value.issue({
    audience: 'device', credentialId: CREDENTIAL_ID, requesterKind: 'device',
    generation: 1, expiresAt: LATER,
  });
  for (const expected of [
    { audience: 'web-session' },
    { audience: 'device', credentialId: `qncred_${'X'.repeat(32)}` },
    { audience: 'device', requesterKind: 'web-session' },
    { audience: 'device', generation: 2 },
  ]) {
    assert.throws(() => value.verify(token, expected), { code: 'query_credential_invalid' });
  }
  assert.throws(() => authority('forrest').value.verify(token, { audience: 'device' }),
    { code: 'query_credential_invalid' });
  assert.throws(() => value.verify(`${token}x`, { audience: 'device' }),
    { code: 'query_credential_invalid' });

  const [payload] = token.split('.');
  const generic = crypto.createHmac('sha256', deriveQueryNotebookCredentialKey({
    bridgeToken: BRIDGE_TOKEN, requesterAgent: 'jerry',
  })).update(Buffer.from(payload!, 'base64url')).digest('base64url');
  assert.throws(() => value.verify(`${payload}.${generic}`, { audience: 'device' }),
    { code: 'query_credential_invalid' });

  setNow(LATER);
  assert.throws(() => value.verify(token, { audience: 'device' }),
    { code: 'query_credential_invalid' });
  assert.throws(() => createQueryNotebookCredentialAuthority({
    bridgeToken: '', requesterAgent: 'jerry',
  }), { code: 'query_credential_configuration_invalid' });
});

test('device registry atomically migrates v1 while preserving legacy Chat rows', () => {
  withTempRegistry((filePath, directory) => {
    const legacyDevice = {
      device_token: '0123456789abcdef0123456789abcdef',
      chat_ids: ['ios_chat_a', 'ios_chat_a', 'ios_chat_b'],
      registered_at: NOW,
      last_seen_at: NOW,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      agent_id: 'jerry',
      platform: 'ios',
      local_extension_field: { preserve: true },
    };
    writeFileSync(filePath, JSON.stringify({ version: 1, devices: [legacyDevice] }, null, 2));

    const registry = new DeviceRegistry(filePath, {
      now: () => Date.parse(NOW),
      randomBytes: () => Buffer.alloc(24, 0xab),
    });
    assert.deepEqual(registry.list(), [legacyDevice]);

    const migrated = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.devices, [legacyDevice]);
    assert.deepEqual(migrated.query_credentials, []);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directory), ['device-registry.json']);
  });
});

test('query credential enrollment and revocation are monotonic and APNs-independent', () => {
  withTempRegistry((filePath) => {
    let now = Date.parse(NOW);
    const chatRow = {
      device_token: 'abcdefabcdefabcdefabcdefabcdefab',
      chat_ids: ['chat-z', 'chat-a', 'chat-z'],
      registered_at: NOW,
      last_seen_at: NOW,
      bundle_id: 'com.regina6.home23',
      env: 'production',
    };
    writeFileSync(filePath, JSON.stringify({ version: 1, devices: [chatRow] }, null, 2));
    const registry = new DeviceRegistry(filePath, {
      now: () => now,
      randomBytes: () => Buffer.alloc(24, 0xcd),
    });
    const installationId = 'install_0123456789abcdef01234567';

    const first = registry.enrollQueryCredential({ installationId, requesterAgent: 'jerry' });
    assert.equal(first.credential_generation, 1);
    assert.match(first.credential_id, /^qncred_[A-Za-z0-9_-]{32}$/);
    assert.notEqual(first.credential_id, installationId);
    assert.equal(first.revoked_at, null);
    assert.deepEqual(registry.list(), [chatRow]);

    now += 1_000;
    const renewed = registry.enrollQueryCredential({ installationId, requesterAgent: 'jerry' });
    assert.equal(renewed.credential_id, first.credential_id);
    assert.equal(renewed.credential_generation, 2);
    assert.equal(renewed.revoked_at, null);
    assert.deepEqual(registry.list(), [chatRow]);

    now += 1_000;
    const revoked = registry.revokeQueryCredential(installationId, 'jerry');
    assert.equal(revoked?.credential_generation, 3);
    assert.equal(revoked?.revoked_at, '2026-07-13T16:00:02.000Z');
    assert.equal(registry.getQueryCredential(installationId, 'jerry')?.credential_generation, 3);
    assert.deepEqual(registry.list(), [chatRow]);

    now += 1_000;
    const restored = registry.enrollQueryCredential({ installationId, requesterAgent: 'jerry' });
    assert.equal(restored.credential_id, first.credential_id);
    assert.equal(restored.credential_generation, 4);
    assert.equal(restored.revoked_at, null);
    assert.deepEqual(registry.getQueryCredentialByCredentialId(first.credential_id, 'jerry'), restored);
    assert.deepEqual(registry.queryCredentialSnapshot(), [restored]);
    assert.deepEqual(registry.list(), [chatRow]);

    const restarted = new DeviceRegistry(filePath);
    assert.deepEqual(restarted.getQueryCredential(installationId, 'jerry'), restored);
    assert.deepEqual(restarted.list(), [chatRow]);
  });
});

test('corrupt credential authority fails closed without resetting registry bytes', () => {
  for (const raw of [
    '{ not-json',
    JSON.stringify({
      version: 2,
      devices: [],
      query_credentials: [{ installation_id: 'install_0123456789abcdef01234567' }],
    }),
  ]) {
    withTempRegistry((filePath) => {
      writeFileSync(filePath, raw);
      const registry = new DeviceRegistry(filePath);
      assert.throws(() => registry.list(), { code: 'device_registry_corrupt' });
      assert.equal(readFileSync(filePath, 'utf8'), raw);
    });
  }
});

async function postCredential(
  app: express.Express,
  body: unknown,
  authorization?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/device/query-credential`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('query credential enrollment requires configured bridge bearer and exact identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-query-route-'));
  try {
    const registry = new DeviceRegistry(join(directory, 'device-registry.json'));
    const body = { installationId: 'install_0123456789abcdef01234567', agent: 'jerry' };

    const unavailable = express();
    unavailable.use(express.json());
    unavailable.post('/api/device/query-credential', createQueryCredentialHandler({
      agentName: 'jerry', registry,
    }));
    assert.deepEqual(await postCredential(unavailable, body), {
      status: 503, body: { error: 'query_credential_unavailable' },
    });

    const configured = express();
    configured.use(express.json());
    configured.post('/api/device/query-credential', createQueryCredentialHandler({
      agentName: 'jerry',
      registry,
      token: BRIDGE_TOKEN,
      queryCredentialAuthority: authority().value,
      now: () => Date.parse(NOW),
    }));
    assert.equal((await postCredential(configured, body)).status, 401);
    assert.equal((await postCredential(configured, body, 'Bearer wrong')).status, 401);
    assert.equal((await postCredential(configured, { ...body, agent: 'forrest' }, `Bearer ${BRIDGE_TOKEN}`)).status, 400);
    assert.equal((await postCredential(configured, {
      ...body, installationId: `install_${'x'.repeat(200)}`,
    }, `Bearer ${BRIDGE_TOKEN}`)).status, 400);
    assert.equal((await postCredential(configured, {
      ...body, unexpected: true,
    }, `Bearer ${BRIDGE_TOKEN}`)).status, 400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('query credential enrollment is bounded ahead of the broad Chat body parser', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-query-route-'));
  try {
    const registry = new DeviceRegistry(join(directory, 'device-registry.json'));
    const app = express();
    app.post(
      '/api/device/query-credential',
      createQueryCredentialJsonParser(),
      createQueryCredentialHandler({
        agentName: 'jerry',
        registry,
        token: BRIDGE_TOKEN,
        queryCredentialAuthority: authority().value,
      }),
    );
    const result = await postCredential(app, {
      installationId: 'install_0123456789abcdef01234567',
      agent: 'jerry',
      padding: 'x'.repeat(4_096),
    }, `Bearer ${BRIDGE_TOKEN}`);
    assert.deepEqual(result, { status: 413, body: { error: 'invalid_request' } });
    assert.deepEqual(registry.queryCredentialSnapshot(), []);

    const homeSource = readFileSync(new URL('../../src/home.ts', import.meta.url), 'utf8');
    const boundedMount = homeSource.indexOf("'/api/device/query-credential'");
    const broadParser = homeSource.indexOf("bridgeApp.use(express.json({ limit: '90mb' }))");
    assert.ok(boundedMount > 0 && broadParser > boundedMount,
      'credential route must be mounted before the broad Chat parser');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('query credential enrollment returns only a bounded receipt and survives restart without APNs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-query-route-'));
  try {
    const filePath = join(directory, 'device-registry.json');
    const registry = new DeviceRegistry(filePath, {
      now: () => Date.parse(NOW),
      randomBytes: () => Buffer.alloc(24, 0xee),
    });
    const credentialAuthority = authority().value;
    const app = express();
    app.use(express.json());
    app.post('/api/device/query-credential', createQueryCredentialHandler({
      agentName: 'jerry',
      registry,
      token: BRIDGE_TOKEN,
      queryCredentialAuthority: credentialAuthority,
      now: () => Date.parse(NOW),
    }));
    const installationId = 'install_0123456789abcdef01234567';
    const first = await postCredential(app, { installationId, agent: 'jerry' }, `Bearer ${BRIDGE_TOKEN}`);
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['credentialId', 'expiresAt', 'generation', 'token']);
    assert.match(String(first.body.credentialId), /^qncred_[A-Za-z0-9_-]{32}$/);
    assert.notEqual(first.body.credentialId, installationId);
    assert.equal(first.body.generation, 1);
    assert.equal(first.body.expiresAt, '2026-08-12T16:00:00.000Z');
    assert.equal(typeof first.body.token, 'string');
    assert.ok(String(first.body.token).length <= 2048);
    assert.equal(JSON.stringify(first.body).includes(BRIDGE_TOKEN), false);
    assert.equal(JSON.stringify(first.body).includes(installationId), false);
    assert.deepEqual(credentialAuthority.verify(String(first.body.token), {
      audience: 'device',
      credentialId: String(first.body.credentialId),
      requesterKind: 'device',
      generation: 1,
    }).requesterAgent, 'jerry');
    assert.deepEqual(registry.list(), []);

    const restarted = new DeviceRegistry(filePath);
    assert.equal(restarted.getQueryCredential(installationId, 'jerry')?.credential_generation, 1);
    const second = await postCredential(app, { installationId, agent: 'jerry' }, `Bearer ${BRIDGE_TOKEN}`);
    assert.equal(second.body.credentialId, first.body.credentialId);
    assert.equal(second.body.generation, 2);
    assert.throws(() => credentialAuthority.verify(String(first.body.token), {
      audience: 'device',
      credentialId: String(first.body.credentialId),
      requesterKind: 'device',
      generation: restarted.getQueryCredential(installationId, 'jerry')!.credential_generation + 1,
    }), { code: 'query_credential_invalid' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
